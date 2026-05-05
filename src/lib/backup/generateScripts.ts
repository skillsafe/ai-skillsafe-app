import { atomicWrite, ensureDir, safeReadDir, type FsAdapter } from "../fs";
import { agents } from "../agents/registry";
import {
  MACOS_PLIST,
  MACOS_RESTORE_SH,
  MACOS_SH,
  README_MAC,
  README_WIN,
  WINDOWS_PS1,
  WINDOWS_REGISTER_PS1,
  WINDOWS_RESTORE_PS1,
} from "./scriptTemplates";
import {
  dataTypesFor,
  defaultDataTypeIdsFor,
  extraSourceFor,
  isExtraSource,
  normalizeDataTypeIds,
  type DataType,
} from "./dataTypes";

export type BackupPlatform = "macos" | "windows";

export interface ScheduleSpec {
  hour: number; // 0-23
  minute: number; // 0-59
  // null/undefined = run every day at <hour>:<minute>; otherwise only on the
  // listed weekdays (0=Sunday … 6=Saturday). Empty array means daily.
  weekdays?: number[] | null;
}

export const DEFAULT_SCHEDULE: ScheduleSpec = { hour: 12, minute: 15, weekdays: null };

export interface GenerateScriptsOptions {
  fs: FsAdapter;
  joiner: { join: (...parts: string[]) => Promise<string> };
  platform: BackupPlatform;
  home: string;
  destination: string;
  outDir: string;
  label?: string;
  schedule?: ScheduleSpec;
  // Subset of agent registry keys to back up. Tools not listed are skipped.
  // For backwards compat, when omitted the script falls back to ["claude"].
  tools?: string[];
  // Per-tool selection of data-type ids (see dataTypes.ts). Tools missing
  // from the map default to their default-enabled set.
  dataTypes?: Record<string, string[]>;
}

export interface GeneratedFile {
  path: string;
  bytes: number;
}

export interface GenerateScriptsResult {
  outDir: string;
  platform: BackupPlatform;
  files: GeneratedFile[];
}

const DEFAULT_LABEL = "ai.skillsafe.backup";

export async function generateScripts(
  opts: GenerateScriptsOptions,
): Promise<GenerateScriptsResult> {
  const label = opts.label ?? DEFAULT_LABEL;
  await ensureDir(opts.fs, opts.outDir);
  // Sweep any orphan *.tmp.<digits> files from previous runs. atomicWrite
  // tries direct overwrite first now and only falls back to tmp+rename when
  // that fails, so going forward this should usually be a no-op — but older
  // generations of atomicWrite always wrote a tmp and could leave orphans
  // when rename was interrupted.
  await sweepLocalTmps(opts.fs, opts.joiner, opts.outDir);
  if (opts.platform === "macos") {
    return generateMac({ ...opts, label });
  }
  return generateWindows({ ...opts, label });
}

async function sweepLocalTmps(
  fs: FsAdapter,
  joiner: { join: (...parts: string[]) => Promise<string> },
  dir: string,
): Promise<void> {
  let entries;
  try {
    entries = await safeReadDir(fs, dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (!/\.tmp\.\d+$/.test(entry.name)) continue;
    const child = await joiner.join(dir, entry.name);
    try { await fs.remove(child); } catch { /* best-effort */ }
  }
}

interface PreparedOptions extends GenerateScriptsOptions {
  label: string;
}

async function generateMac(opts: PreparedOptions): Promise<GenerateScriptsResult> {
  const scriptPath = await opts.joiner.join(opts.outDir, "claude_backup.sh");
  const restorePath = await opts.joiner.join(opts.outDir, "claude_restore.sh");
  const plistPath = await opts.joiner.join(opts.outDir, `${opts.label}.plist`);
  const readmePath = await opts.joiner.join(opts.outDir, "README.md");
  const schedule = opts.schedule ?? DEFAULT_SCHEDULE;
  const tools = normalizeTools(opts.tools);
  const sections = await resolveSections(opts, tools, opts.dataTypes);

  const replacements = {
    HOME: opts.home,
    DEST: opts.destination,
    LABEL: opts.label,
    SCRIPT_PATH: scriptPath,
    PLIST_PATH: plistPath,
    CALENDAR_INTERVAL: renderCalendarInterval(schedule),
    N: String(sections.length),
    TOOL_SECTIONS: renderBashSections(sections),
    TOOL_LIST_MD: renderToolListMd(sections, opts.home),
    SCAN_SECTIONS: renderBashRestoreSections(sections, "scan"),
    APPLY_SECTIONS: renderBashRestoreSections(sections, "apply"),
  };

  const sh = substitute(MACOS_SH, replacements);
  const plist = substitute(MACOS_PLIST, replacements);
  const readme = substitute(README_MAC, replacements);
  const restoreSh = substitute(MACOS_RESTORE_SH, replacements);

  return writeAll(opts, [
    { path: scriptPath, contents: sh },
    { path: plistPath, contents: plist },
    { path: readmePath, contents: readme },
    { path: restorePath, contents: restoreSh },
  ]);
}

async function generateWindows(opts: PreparedOptions): Promise<GenerateScriptsResult> {
  const scriptPath = await opts.joiner.join(opts.outDir, "claude_backup.ps1");
  const restorePath = await opts.joiner.join(opts.outDir, "claude_restore.ps1");
  const registerPath = await opts.joiner.join(opts.outDir, "register-task.ps1");
  const readmePath = await opts.joiner.join(opts.outDir, "README.md");
  const tools = normalizeTools(opts.tools);
  const sections = await resolveSections(opts, tools, opts.dataTypes);

  const replacements = {
    HOME: opts.home,
    DEST: opts.destination,
    LABEL: opts.label,
    SCRIPT_PATH: scriptPath,
    REGISTER_SCRIPT_PATH: registerPath,
    N: String(sections.length),
    TOOL_SECTIONS: renderPwshSections(sections),
    TOOL_LIST_MD: renderToolListMd(sections, opts.home),
    SCAN_SECTIONS: renderPwshRestoreSections(sections, "Scan"),
    APPLY_SECTIONS: renderPwshRestoreSections(sections, "Apply"),
  };

  const ps1 = substitute(WINDOWS_PS1, replacements);
  const register = substitute(WINDOWS_REGISTER_PS1, replacements);
  const readme = substitute(README_WIN, replacements);
  const restorePs1 = substitute(WINDOWS_RESTORE_PS1, replacements);

  return writeAll(opts, [
    { path: scriptPath, contents: ps1 },
    { path: registerPath, contents: register },
    { path: readmePath, contents: readme },
    { path: restorePath, contents: restorePs1 },
  ]);
}

interface PendingFile {
  path: string;
  contents: string;
}

async function writeAll(
  opts: PreparedOptions,
  files: PendingFile[],
): Promise<GenerateScriptsResult> {
  const written: GeneratedFile[] = [];
  for (const f of files) {
    assertNoLeftoverPlaceholders(f.path, f.contents);
    await atomicWrite(opts.fs, f.path, f.contents);
    written.push({ path: f.path, bytes: byteLength(f.contents) });
  }
  return { outDir: opts.outDir, platform: opts.platform, files: written };
}

function substitute(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

function assertNoLeftoverPlaceholders(path: string, contents: string): void {
  const m = /{{[A-Z_]+}}/.exec(contents);
  if (m) {
    throw new Error(
      `template substitution incomplete in ${path}: missing replacement for ${m[0]}`,
    );
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

// Renders the <dict>...</dict> (or <array> of <dict>s for weekday-restricted
// schedules) that goes after <key>StartCalendarInterval</key> in the plist.
export function renderCalendarInterval(s: ScheduleSpec): string {
  const hour = clamp(s.hour, 0, 23);
  const minute = clamp(s.minute, 0, 59);
  const days = (s.weekdays ?? []).filter((d) => d >= 0 && d <= 6);
  if (days.length === 0) {
    return `<dict>\n        <key>Hour</key>\n        <integer>${hour}</integer>\n        <key>Minute</key>\n        <integer>${minute}</integer>\n    </dict>`;
  }
  // Multiple weekdays => an array of <dict>s, one per day.
  const items = days
    .map(
      (d) =>
        `        <dict>\n            <key>Hour</key>\n            <integer>${hour}</integer>\n            <key>Minute</key>\n            <integer>${minute}</integer>\n            <key>Weekday</key>\n            <integer>${d}</integer>\n        </dict>`,
    )
    .join("\n");
  return `<array>\n${items}\n    </array>`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// One renderable section per (tool, data-type) selection. Each section maps
// to a discrete destination subdir under the user's backup root.
interface Section {
  tool: string;
  toolLabel: string;
  // Tool's config root (parent of globalSkillsDir). Empty for the synthetic
  // "claude_desktop" data-type, which has hardcoded source paths.
  configRoot: string;
  dataType: DataType;
  // Destination relative to <dest>: "<tool>" + ("/<dataTypeId>" unless the
  // type is the only one for the tool and is "all" — preserves the prior
  // flat layout for unknown tools).
  destSubdir: string;
}

function normalizeTools(tools: string[] | undefined): string[] {
  const list = (tools && tools.length > 0 ? tools : ["claude"]).filter(
    (t) => agents[t] !== undefined || isExtraSource(t),
  );
  // Stable order so the script body is deterministic across runs.
  return Array.from(new Set(list)).sort();
}

async function resolveSections(
  opts: PreparedOptions,
  tools: string[],
  dataTypes: Record<string, string[]> | undefined,
): Promise<Section[]> {
  const deps = {
    homeDir: () => Promise.resolve(opts.home),
    join: (...parts: string[]) => opts.joiner.join(...parts),
  };
  const out: Section[] = [];
  for (const tool of tools) {
    let configRoot: string;
    let toolLabel: string;
    const extra = extraSourceFor(tool);
    if (extra) {
      configRoot = await extra.configRoot(deps);
      toolLabel = extra.displayName;
    } else {
      const cfg = agents[tool];
      if (!cfg) continue;
      const skillsDir = await cfg.globalSkillsDir(deps);
      configRoot = parentDir(skillsDir);
      toolLabel = cfg.displayName;
    }

    const all = dataTypesFor(tool);
    const requested =
      dataTypes && tool in dataTypes
        ? normalizeDataTypeIds(tool, dataTypes[tool] ?? [])
        : defaultDataTypeIdsFor(tool);
    const flat = all.length === 1 && all[0].id === "all";

    for (const dt of all) {
      if (!requested.includes(dt.id)) continue;
      out.push({
        tool,
        toolLabel,
        configRoot,
        dataType: dt,
        destSubdir: flat ? tool : `${tool}/${dt.id}`,
      });
    }
  }
  return out;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return trimmed;
  return trimmed.slice(0, idx);
}

function joinPosix(a: string, b: string): string {
  if (b === "." || b === "") return a;
  return `${a.replace(/[\\/]+$/, "")}/${b.replace(/^[\\/]+/, "")}`;
}

function joinWin(a: string, b: string): string {
  if (b === "." || b === "") return a;
  return `${a.replace(/[\\/]+$/, "")}\\${b.replace(/^[\\/]+/, "")}`;
}

// Excludes applied to Claude's tree-mode sections. Earlier versions backed up
// the entire ~/.claude/ tree with a long exclude list; with the new
// data-type registry, sections target specific subdirs (skills/, projects/,
// …) so most of these never apply. The cache/projects globs are still useful
// when the user picks "Memory & projects" — `projects/*-Library-CloudStorage-*`
// avoids backing up indexed copies of cloud-mounted projects.
const CLAUDE_RSYNC_EXCLUDES = [
  ".DS_Store",
  "cache/",
  "debug/",
  "session-env/",
  "shell-snapshots/",
  "telemetry/",
  "usage-data/",
  "statsig/",
  "downloads/",
  "paste-cache/",
  "ide/",
  "channels/",
  "plugins/cache/",
  "mcp-needs-auth-cache.json",
  "policy-limits.json",
  "stats-cache.json",
  // ~/.claude/plugins/install-counts-cache.json — re-fetched from the
  // marketplace on every Claude launch, so backing it up just bloats the
  // mirror and burns OneDrive sync churn.
  "install-counts-cache.json",
  "-Users-*-Library-CloudStorage-*",
];

function renderBashSections(sections: Section[]): string {
  if (sections.length === 0) return 'log "No tools selected — nothing to back up."';
  return sections.map(renderBashSection).join("\n\n");
}

function renderBashSection(s: Section): string {
  if (s.dataType.kind === "claude_desktop") {
    return renderBashClaudeDesktop(s);
  }
  if (s.dataType.kind === "files") {
    return renderBashFiles(s);
  }
  return renderBashTree(s);
}

// rsync flags shared by every section:
//   -a / --copy-unsafe-links — preserve perms+times, materialize external
//                              symlinks so the linked content is in the backup.
//   --inplace                — write directly to the dest file. Required for
//                              destinations on OneDrive/iCloud/Dropbox where
//                              the temp+rename dance hits "Operation not
//                              permitted" on renameat.
//   --ignore-errors          — let --delete run even when there are I/O
//                              errors (broken symlinks, vanished files).
//                              Without this rsync silently skips deletion
//                              after any error, leaving stale paths in the
//                              backup and breaking layout migrations.
const RSYNC_BASE = "rsync -a --copy-unsafe-links --inplace --ignore-errors";

// Track rsync exit codes: 23/24 are "partial transfer" / "vanished file" —
// usually a broken symlink or a file that disappeared mid-scan. Those are
// warnings, not failures (the rest of the section copied fine). Anything
// else non-zero is a real failure.
function bashClassifyRsync(): string[] {
  return [
    `EC=$?`,
    `if [ $EC -ne 0 ]; then`,
    `  if [ $EC -eq 23 ] || [ $EC -eq 24 ]; then WARN=1; else RC=$EC; fi`,
    `fi`,
  ];
}

function bashSectionCloser(destSubdir: string, withSize: boolean): string {
  const okSize = withSize
    ? `($(du -sh "$MIRROR/${destSubdir}" 2>/dev/null | cut -f1))`
    : "";
  return [
    `if [ $RC -ne 0 ]; then`,
    `  log "[$STEP/$N] FAILED"`,
    `  FAILURES=$((FAILURES+1))`,
    `elif [ $WARN -ne 0 ]; then`,
    `  log "[$STEP/$N] OK with warnings (broken symlink or vanished file — see log)"`,
    `else`,
    `  log "[$STEP/$N] OK ${okSize}"`,
    `fi`,
  ].join("\n");
}

function renderBashTree(s: Section): string {
  const excludes = s.tool === "claude" ? CLAUDE_RSYNC_EXCLUDES : [".DS_Store"];
  const excludeFlags = excludes.map((e) => `  --exclude='${e}' \\`).join("\n");
  const lines: string[] = [
    `STEP=$((STEP+1))`,
    `mkdir -p "$MIRROR/${s.destSubdir}"`,
    `log "[$STEP/$N] Sync ${s.toolLabel} · ${s.dataType.label} ..."`,
    `RC=0`,
    `WARN=0`,
  ];
  // Single-path data types skip the inner level — destSubdir already names
  // the slice (e.g. "claude/skills"), so nesting source-name "skills" inside
  // would write to "claude/skills/skills/", which is the duplication users
  // see in the backup browser. Multi-path types (e.g. tasks-plans → tasks +
  // plans) keep the inner level so paths don't collide.
  const single = s.dataType.paths.length === 1;
  // One-time legacy-layout migration: older script versions wrote single-path
  // tree types to <destSubdir>/<rel>/. The new layout writes to
  // <destSubdir>/ directly. rsync --delete *should* clean up the leftover
  // nested dir, but it auto-disables on any I/O error (broken symlinks etc.)
  // even with --ignore-errors in some rsync builds, so we remove it
  // explicitly. No-op when nothing's there.
  if (single) {
    for (const rel of s.dataType.paths) {
      if (rel === "." || rel === "") continue;
      lines.push(
        `[ -d "$MIRROR/${s.destSubdir}/${rel}" ] && rm -rf "$MIRROR/${s.destSubdir}/${rel}" 2>/dev/null || true`,
      );
    }
  }
  for (const rel of s.dataType.paths) {
    const src = joinPosix(s.configRoot, rel);
    const inner = single || rel === "." ? "" : `${rel}/`;
    lines.push(
      `if [ -e "${src}" ]; then`,
      // --delete-excluded: also remove files from the destination that
      // match newly-added exclude patterns (e.g. install-counts-cache.json
      // when we tighten the cache filter). Without this, previously-mirrored
      // cache files would linger in the backup forever.
      `  ${RSYNC_BASE} --delete --delete-excluded \\`,
      excludeFlags,
      `  "${src}/" "$MIRROR/${s.destSubdir}/${inner}"`,
      ...bashClassifyRsync().map((l) => `  ${l}`),
      `else`,
      `  log "[$STEP/$N]   skipped (missing: ${src})"`,
      `fi`,
    );
  }
  lines.push(bashSectionCloser(s.destSubdir, true));
  return lines.join("\n");
}

function renderBashFiles(s: Section): string {
  const lines: string[] = [
    `STEP=$((STEP+1))`,
    `mkdir -p "$MIRROR/${s.destSubdir}"`,
    `log "[$STEP/$N] Sync ${s.toolLabel} · ${s.dataType.label} ..."`,
    `RC=0`,
    `WARN=0`,
  ];
  for (const rel of s.dataType.paths) {
    const src = joinPosix(s.configRoot, rel);
    lines.push(
      `if [ -e "${src}" ]; then`,
      `  ${RSYNC_BASE} "${src}" "$MIRROR/${s.destSubdir}/"`,
      ...bashClassifyRsync().map((l) => `  ${l}`),
      `fi`,
    );
  }
  lines.push(bashSectionCloser(s.destSubdir, false));
  return lines.join("\n");
}

function renderBashClaudeDesktop(s: Section): string {
  // Source paths live under ~/Library/Application Support/Claude/, not under
  // any agent's config root. Hardcoded here because the data type's `paths`
  // are filenames only.
  const lines: string[] = [
    `STEP=$((STEP+1))`,
    `mkdir -p "$MIRROR/${s.destSubdir}"`,
    `log "[$STEP/$N] Sync ${s.toolLabel} · ${s.dataType.label} ..."`,
    `RC=0`,
    `WARN=0`,
  ];
  for (const filename of s.dataType.paths) {
    const src = `$HOME/Library/Application Support/Claude/${filename}`;
    lines.push(
      `if [ -f "${src}" ]; then`,
      `  ${RSYNC_BASE} "${src}" "$MIRROR/${s.destSubdir}/"`,
      ...bashClassifyRsync().map((l) => `  ${l}`),
      `fi`,
    );
  }
  lines.push(bashSectionCloser(s.destSubdir, false));
  return lines.join("\n");
}

function renderPwshSections(sections: Section[]): string {
  if (sections.length === 0) return 'Write-Log "No tools selected — nothing to back up."';
  return sections.map(renderPwshSection).join("\n\n");
}

function renderPwshSection(s: Section): string {
  if (s.dataType.kind === "claude_desktop") {
    return renderPwshClaudeDesktop(s);
  }
  if (s.dataType.kind === "files") {
    return renderPwshFiles(s);
  }
  return renderPwshTree(s);
}

function renderPwshTree(s: Section): string {
  const winRoot = toWindowsPath(s.configRoot);
  const excludeDirs =
    s.tool === "claude"
      ? `@("cache","debug","session-env","shell-snapshots","telemetry","usage-data","statsig","downloads","paste-cache","ide","channels")`
      : `@()`;
  const excludeFiles =
    s.tool === "claude"
      ? `@("mcp-needs-auth-cache.json","policy-limits.json","stats-cache.json")`
      : `@()`;
  const lines: string[] = [
    `$Step++`,
    `Write-Log "[$Step/$N] Sync ${s.toolLabel} · ${s.dataType.label} ..."`,
    `New-Item -ItemType Directory -Force -Path "$Mirror\\${s.destSubdir.replace(/\//g, "\\")}" | Out-Null`,
  ];
  // Match the bash renderer's flattening: single-path tree types live at
  // $Mirror\<destSubdir>\, multi-path types nest one level deeper.
  const singleTree = s.dataType.paths.length === 1;
  for (const rel of s.dataType.paths) {
    const winSrc = rel === "." ? winRoot : joinWin(winRoot, rel);
    const isRoot = rel === "." || rel === "";
    const dest = isRoot || singleTree
      ? `$Mirror\\${s.destSubdir.replace(/\//g, "\\")}`
      : `$Mirror\\${s.destSubdir.replace(/\//g, "\\")}\\${rel.replace(/\//g, "\\")}`;
    lines.push(
      `if (Test-Path "${winSrc}") {`,
      `  & robocopy "${winSrc}" "${dest}" /MIR /R:2 /W:5 /NFL /NDL /NP /XD ${excludeDirs} /XF ${excludeFiles} | Out-Null`,
      `  if ($LASTEXITCODE -ge 8) { Write-Log "[$Step/$N] FAILED ($LASTEXITCODE)"; $failures++ }`,
      `}`,
    );
  }
  lines.push(`Write-Log "[$Step/$N] OK"`);
  return lines.join("\n");
}

function renderPwshFiles(s: Section): string {
  const winRoot = toWindowsPath(s.configRoot);
  const lines: string[] = [
    `$Step++`,
    `Write-Log "[$Step/$N] Sync ${s.toolLabel} · ${s.dataType.label} ..."`,
    `New-Item -ItemType Directory -Force -Path "$Mirror\\${s.destSubdir.replace(/\//g, "\\")}" | Out-Null`,
  ];
  for (const rel of s.dataType.paths) {
    const winSrc = joinWin(winRoot, rel);
    lines.push(
      `if (Test-Path "${winSrc}") {`,
      `  Copy-Item "${winSrc}" "$Mirror\\${s.destSubdir.replace(/\//g, "\\")}\\" -Force -Recurse`,
      `}`,
    );
  }
  lines.push(`Write-Log "[$Step/$N] OK"`);
  return lines.join("\n");
}

function renderPwshClaudeDesktop(s: Section): string {
  const lines: string[] = [
    `$Step++`,
    `Write-Log "[$Step/$N] Sync ${s.toolLabel} · ${s.dataType.label} ..."`,
    `New-Item -ItemType Directory -Force -Path "$Mirror\\${s.destSubdir.replace(/\//g, "\\")}" | Out-Null`,
  ];
  for (const filename of s.dataType.paths) {
    const src = `$env:APPDATA\\Claude\\${filename}`;
    lines.push(
      `if (Test-Path "${src}") {`,
      `  Copy-Item "${src}" "$Mirror\\${s.destSubdir.replace(/\//g, "\\")}\\" -Force`,
      `}`,
    );
  }
  lines.push(`Write-Log "[$Step/$N] OK"`);
  return lines.join("\n");
}

function toWindowsPath(p: string): string {
  // Source paths are computed via the renderer's joiner, which on Windows
  // already produces backslashes. On macOS we generate the .ps1 with our
  // POSIX joiner — convert here so the script is correct when copied across.
  return p.replace(/\//g, "\\");
}

function renderToolListMd(sections: Section[], home: string): string {
  if (sections.length === 0) return "- (none — pick at least one tool in Settings → Backup)";
  return sections
    .map((s) => {
      if (s.dataType.kind === "claude_desktop") {
        const list = s.dataType.paths
          .map((f) => `${home}/Library/Application Support/Claude/${f}`)
          .join(", ");
        return `- ${s.toolLabel} · ${s.dataType.label} (${list})`;
      }
      const sources = s.dataType.paths
        .map((rel) => (rel === "." ? `${s.configRoot}/` : joinPosix(s.configRoot, rel)))
        .join(", ");
      return `- ${s.toolLabel} · ${s.dataType.label} (${sources})`;
    })
    .join("\n");
}

// Each backup section produces one or more (src, dst, label) restore mappings
// — one per `paths` entry. Centralized so the bash and pwsh renderers stay in
// sync and the tests can assert the reverse path mapping directly.
export interface RestoreMapping {
  label: string;
  src: string;
  dst: string;
  /** "dir" => trailing-slash semantics for rsync; "file" => single-file copy. */
  kind: "dir" | "file";
}

/** When `roots` is omitted, paths use `$MIRROR` and `$HOME` placeholders so
 *  the bash renderer can drop them straight into the script. When provided
 *  with concrete `mirror` + `home` roots, this returns ready-to-use absolute
 *  paths suitable for the TS-side scan/apply. */
function buildRestoreMappings(
  sections: Section[],
  roots?: { mirror: string; home: string },
): RestoreMapping[] {
  const M = roots?.mirror ?? "$MIRROR";
  const H = roots?.home ?? "$HOME";
  const out: RestoreMapping[] = [];
  for (const s of sections) {
    if (s.dataType.kind === "claude_desktop") {
      for (const filename of s.dataType.paths) {
        out.push({
          label: `${s.toolLabel} · ${s.dataType.label} · ${filename}`,
          src: `${M}/${s.destSubdir}/${filename}`,
          dst: `${H}/Library/Application Support/Claude/`,
          kind: "file",
        });
      }
      continue;
    }
    if (s.dataType.kind === "files") {
      for (const filename of s.dataType.paths) {
        out.push({
          label: `${s.toolLabel} · ${s.dataType.label} · ${filename}`,
          src: `${M}/${s.destSubdir}/${filename}`,
          dst: `${s.configRoot}/`,
          kind: "file",
        });
      }
      continue;
    }
    // tree — must match the backup-side flattening: single-path data types
    // are stored at <dest>/<destSubdir>/, multi-path types nest under
    // <dest>/<destSubdir>/<rel>/.
    const singleTree = s.dataType.paths.length === 1;
    for (const rel of s.dataType.paths) {
      const isRoot = rel === "." || rel === "";
      const inner = isRoot || singleTree ? "" : `${rel}/`;
      out.push({
        label: `${s.toolLabel} · ${s.dataType.label}${isRoot ? "" : ` · ${rel}/`}`,
        src: `${M}/${s.destSubdir}/${inner}`,
        dst: isRoot ? `${s.configRoot}/` : `${s.configRoot}/${rel}/`,
        kind: "dir",
      });
    }
  }
  return out;
}

/** Public adapter: re-resolve sections + mappings against a concrete home /
 *  destination. Used by the TS-side scanner so the React UI can ask "what
 *  would actually change on disk?" without shelling out. */
export async function resolveRestoreMappings(opts: {
  fs: FsAdapter;
  joiner: { join: (...parts: string[]) => Promise<string> };
  home: string;
  destination: string;
  tools: string[];
  dataTypes?: Record<string, string[]>;
}): Promise<RestoreMapping[]> {
  const tools = normalizeTools(opts.tools);
  const sections = await resolveSections(
    {
      fs: opts.fs,
      joiner: opts.joiner,
      home: opts.home,
      destination: opts.destination,
      label: DEFAULT_LABEL,
      platform: "macos",
      outDir: "",
      tools,
      dataTypes: opts.dataTypes,
    } as PreparedOptions,
    tools,
    opts.dataTypes,
  );
  return buildRestoreMappings(sections, { mirror: opts.destination, home: opts.home });
}

function renderBashRestoreSections(
  sections: Section[],
  fn: "scan" | "apply",
): string {
  const mappings = buildRestoreMappings(sections);
  if (mappings.length === 0) {
    return fn === "scan"
      ? 'log "(nothing to restore — backup contains no recognized tools)"'
      : "";
  }
  // bash: scan "<label>" "<src>" "<dst>"
  return mappings
    .map((m) => `${fn} "${shEscape(m.label)}" "${m.src}" "${m.dst}"`)
    .join("\n");
}

function shEscape(s: string): string {
  // Restore labels are derived from registry display names — control them
  // tightly so a stray quote doesn't break the bash double-quoted string.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderPwshRestoreSections(
  sections: Section[],
  fn: "Scan" | "Apply",
): string {
  const mappings = buildRestoreMappings(sections);
  if (mappings.length === 0) {
    return fn === "Scan"
      ? 'Write-Log "(nothing to restore — backup contains no recognized tools)"'
      : "";
  }
  return mappings
    .map((m) => {
      const winSrc = pwshFromShellPath(m.src);
      const winDst = pwshFromShellPath(m.dst);
      return `${fn} "${pwshEscape(m.label)}" "${winSrc}" "${winDst}"`;
    })
    .join("\n");
}

function pwshFromShellPath(s: string): string {
  // Mappings are produced for the bash script first — convert $HOME and
  // $MIRROR sigils into PowerShell vars and POSIX seps into Windows seps so
  // we can reuse the same buildRestoreMappings() output.
  return s
    .replace(/\$HOME/g, "$env:USERPROFILE")
    .replace(/\$MIRROR/g, "$Mirror2")
    .replace(/\//g, "\\");
}

function pwshEscape(s: string): string {
  return s.replace(/`/g, "``").replace(/"/g, '`"');
}

// Visible to tests so they can verify per-tool section output without going
// through the full file-write flow.
export const __testing = {
  normalizeTools,
  resolveSections,
  renderBashSections,
  renderPwshSections,
  renderBashRestoreSections,
  renderPwshRestoreSections,
  buildRestoreMappings,
  parentDir,
};

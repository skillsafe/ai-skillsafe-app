import { atomicWrite, ensureDir, safeReadDir, type FsAdapter } from "../fs";
import { agents, displayNameOf } from "../agents/registry";
import {
  MACOS_PLIST,
  MACOS_SH,
  README_MAC,
  README_WIN,
  WINDOWS_PS1,
  WINDOWS_REGISTER_PS1,
} from "./scriptTemplates";

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
  // Subset of agent registry keys to back up. Always emits a section per
  // entry; if "claude" is included, also emits a section for the
  // Claude Desktop config files.
  tools?: string[];
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
  const plistPath = await opts.joiner.join(opts.outDir, `${opts.label}.plist`);
  const readmePath = await opts.joiner.join(opts.outDir, "README.md");
  const schedule = opts.schedule ?? DEFAULT_SCHEDULE;
  const tools = normalizeTools(opts.tools);
  const sources = await resolveToolSources(opts, tools);

  const replacements = {
    HOME: opts.home,
    DEST: opts.destination,
    LABEL: opts.label,
    SCRIPT_PATH: scriptPath,
    PLIST_PATH: plistPath,
    CALENDAR_INTERVAL: renderCalendarInterval(schedule),
    N: String(sources.length),
    TOOL_SECTIONS: renderBashSections(sources, opts.home),
    TOOL_LIST_MD: renderToolListMd(sources, opts.home),
  };

  const sh = substitute(MACOS_SH, replacements);
  const plist = substitute(MACOS_PLIST, replacements);
  const readme = substitute(README_MAC, replacements);

  return writeAll(opts, [
    { path: scriptPath, contents: sh },
    { path: plistPath, contents: plist },
    { path: readmePath, contents: readme },
  ]);
}

async function generateWindows(opts: PreparedOptions): Promise<GenerateScriptsResult> {
  const scriptPath = await opts.joiner.join(opts.outDir, "claude_backup.ps1");
  const registerPath = await opts.joiner.join(opts.outDir, "register-task.ps1");
  const readmePath = await opts.joiner.join(opts.outDir, "README.md");
  const tools = normalizeTools(opts.tools);
  const sources = await resolveToolSources(opts, tools);

  const replacements = {
    HOME: opts.home,
    DEST: opts.destination,
    LABEL: opts.label,
    SCRIPT_PATH: scriptPath,
    REGISTER_SCRIPT_PATH: registerPath,
    N: String(sources.length),
    TOOL_SECTIONS: renderPwshSections(sources, opts.home),
    TOOL_LIST_MD: renderToolListMd(sources, opts.home),
  };

  const ps1 = substitute(WINDOWS_PS1, replacements);
  const register = substitute(WINDOWS_REGISTER_PS1, replacements);
  const readme = substitute(README_WIN, replacements);

  return writeAll(opts, [
    { path: scriptPath, contents: ps1 },
    { path: registerPath, contents: register },
    { path: readmePath, contents: readme },
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

// Per-tool source spec used by the script renderers. One entry per tool the
// user selected, plus an implicit "claude_desktop" row when "claude" is on.
interface ToolSource {
  // Destination subdir under the user's backup root (e.g. "claude").
  destSubdir: string;
  // Display label for the README + log lines.
  label: string;
  // Source directory to mirror, native-separator path. For special-cases
  // (Claude Desktop), an empty source means "use kind-specific logic".
  source: string;
  // Tag selecting renderer behavior. "tree" = recursive rsync; "claude" =
  // tree with the elaborate Claude Code exclude list; "claude_desktop" =
  // copy a fixed pair of config files only.
  kind: "tree" | "claude" | "claude_desktop";
}

function normalizeTools(tools: string[] | undefined): string[] {
  const list = (tools && tools.length > 0 ? tools : ["claude"]).filter(
    (t) => agents[t] !== undefined,
  );
  // Stable order so the script body is deterministic across runs.
  return Array.from(new Set(list)).sort();
}

async function resolveToolSources(
  opts: PreparedOptions,
  tools: string[],
): Promise<ToolSource[]> {
  const deps = {
    homeDir: () => Promise.resolve(opts.home),
    join: (...parts: string[]) => opts.joiner.join(...parts),
  };
  const out: ToolSource[] = [];
  for (const tool of tools) {
    const cfg = agents[tool];
    if (!cfg) continue;
    // Each agent's globalSkillsDir ends in `/skills`. The tool's "config root"
    // is the parent of that — back up the whole config dir so per-agent state
    // (history, plugins, settings, …) comes along, not just the skills tree.
    const skillsDir = await cfg.globalSkillsDir(deps);
    const source = parentDir(skillsDir);
    out.push({
      destSubdir: tool,
      label: cfg.displayName,
      source,
      kind: tool === "claude" ? "claude" : "tree",
    });
  }
  // Claude Desktop config files travel alongside Claude Code — same vendor,
  // small, trivial to back up. Implicit when "claude" is selected.
  if (tools.includes("claude")) {
    out.push({
      destSubdir: "claude_desktop",
      label: "Claude Desktop config",
      source: "",
      kind: "claude_desktop",
    });
  }
  return out;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return trimmed;
  return trimmed.slice(0, idx);
}

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
  "projects/-Users-*-Library-CloudStorage-*",
];

function renderBashSections(sources: ToolSource[], home: string): string {
  if (sources.length === 0) return 'log "No tools selected — nothing to back up."';
  return sources.map((s) => renderBashSection(s, home)).join("\n\n");
}

function renderBashSection(s: ToolSource, home: string): string {
  if (s.kind === "claude_desktop") {
    const cfg1 = `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
    const cfg2 = `${home}/Library/Application Support/Claude/config.json`;
    return [
      `STEP=$((STEP+1))`,
      `mkdir -p "$MIRROR/${s.destSubdir}"`,
      `log "[$STEP/$N] Sync ${s.label} ..."`,
      `RC=0`,
      `if [ -f "${cfg1}" ]; then`,
      `  rsync -a "${cfg1}" "$MIRROR/${s.destSubdir}/" || RC=$?`,
      `fi`,
      `if [ -f "${cfg2}" ]; then`,
      `  rsync -a "${cfg2}" "$MIRROR/${s.destSubdir}/" || RC=$?`,
      `fi`,
      `[ $RC -eq 0 ] && log "[$STEP/$N] OK" || { log "[$STEP/$N] FAILED"; FAILURES=$((FAILURES+1)); }`,
    ].join("\n");
  }
  const excludes = s.kind === "claude" ? CLAUDE_RSYNC_EXCLUDES : [".DS_Store"];
  const excludeFlags = excludes.map((e) => `  --exclude='${e}' \\`).join("\n");
  return [
    `STEP=$((STEP+1))`,
    `mkdir -p "$MIRROR/${s.destSubdir}"`,
    `log "[$STEP/$N] Sync ${s.label} (${s.source}/) ..."`,
    `if [ -d "${s.source}" ]; then`,
    `  rsync -a --delete \\`,
    excludeFlags,
    `  "${s.source}/" "$MIRROR/${s.destSubdir}/"`,
    `  [ $? -eq 0 ] && log "[$STEP/$N] OK ($(du -sh "$MIRROR/${s.destSubdir}" 2>/dev/null | cut -f1))" || { log "[$STEP/$N] FAILED"; FAILURES=$((FAILURES+1)); }`,
    `else`,
    `  log "[$STEP/$N] skipped (source missing: ${s.source})"`,
    `fi`,
  ].join("\n");
}

function renderPwshSections(sources: ToolSource[], home: string): string {
  if (sources.length === 0) return 'Write-Log "No tools selected — nothing to back up."';
  return sources.map((s) => renderPwshSection(s, home)).join("\n\n");
}

function renderPwshSection(s: ToolSource, _home: string): string {
  if (s.kind === "claude_desktop") {
    return [
      `$Step++`,
      `Write-Log "[$Step/$N] Sync ${s.label} ..."`,
      `New-Item -ItemType Directory -Force -Path "$Mirror\\${s.destSubdir}" | Out-Null`,
      `$cfg = "$env:APPDATA\\Claude\\claude_desktop_config.json"`,
      `if (Test-Path $cfg) { Copy-Item $cfg "$Mirror\\${s.destSubdir}\\" -Force; Write-Log "[$Step/$N] OK" }`,
      `else { Write-Log "[$Step/$N] skipped (no config)" }`,
    ].join("\n");
  }
  const winSrc = toWindowsPath(s.source);
  const excludeFlag =
    s.kind === "claude"
      ? `$excludeDirs = @("cache","debug","session-env","shell-snapshots","telemetry","usage-data","statsig","downloads","paste-cache","ide","channels"); $excludeFiles = @("mcp-needs-auth-cache.json","policy-limits.json","stats-cache.json"); `
      : `$excludeDirs = @(); $excludeFiles = @(); `;
  return [
    `$Step++`,
    `Write-Log "[$Step/$N] Sync ${s.label} (${winSrc}) ..."`,
    `New-Item -ItemType Directory -Force -Path "$Mirror\\${s.destSubdir}" | Out-Null`,
    `$src = "${winSrc}"`,
    `if (Test-Path $src) {`,
    `  ${excludeFlag}`,
    `  & robocopy $src "$Mirror\\${s.destSubdir}" /MIR /R:2 /W:5 /NFL /NDL /NP /XD $excludeDirs /XF $excludeFiles | Out-Null`,
    `  if ($LASTEXITCODE -lt 8) { Write-Log "[$Step/$N] OK" } else { Write-Log "[$Step/$N] FAILED ($LASTEXITCODE)"; $failures++ }`,
    `} else { Write-Log "[$Step/$N] skipped (source missing: $src)" }`,
  ].join("\n");
}

function toWindowsPath(p: string): string {
  // Source paths are computed via the renderer's joiner, which on Windows
  // already produces backslashes. On macOS we generate the .ps1 with our
  // POSIX joiner — convert here so the script is correct when copied across.
  return p.replace(/\//g, "\\");
}

function renderToolListMd(sources: ToolSource[], home: string): string {
  if (sources.length === 0) return "- (none — pick at least one tool in Settings → Backup)";
  return sources
    .map((s) => {
      if (s.kind === "claude_desktop") {
        return `- ${s.label} (${home}/Library/Application Support/Claude/{claude_desktop_config,config}.json)`;
      }
      return `- ${s.label} (${s.source}/)`;
    })
    .join("\n");
}

// Visible to tests so they can verify per-tool section output without going
// through the full file-write flow.
export const __testing = {
  normalizeTools,
  resolveToolSources,
  renderBashSections,
  renderPwshSections,
  parentDir,
};

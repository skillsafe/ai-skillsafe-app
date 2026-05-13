import type { ArtifactType, Scope, Tool } from "../artifacts/types";
import {
  atomicWrite,
  ensureDir,
  safeReadDir,
  sha256Bytes,
  type FsAdapter,
} from "../fs";
import { resolveArtifactDir, type PathResolverDeps } from "../paths";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  emptyCounts,
  serializeManifest,
  toolBackupSubdir,
  type BackupCounts,
  type BackupEntry,
  type BackupManifest,
} from "./manifest";

export interface PathJoiner {
  join: (...parts: string[]) => Promise<string>;
}

export interface BackupProgress {
  // Short label for the section currently being mirrored, e.g.
  // "claude · global · skill" or "claude · history".
  phase: string;
  // Files we hashed and considered (i.e. "scanned") so far.
  filesProcessed: number;
  // Files actually written to the destination (status === "added" | "changed").
  filesCopied: number;
  // Total bytes read from sources so far.
  bytesProcessed: number;
  // Total bytes written to dest (sum of bytes for added/changed files).
  bytesCopied: number;
}

export interface RunBackupOptions {
  fs: FsAdapter;
  paths: PathResolverDeps;
  joiner: PathJoiner;
  destination: string;
  tools: ReadonlyArray<Tool>;
  recentProjects: ReadonlyArray<string>;
  includeProjectsHistory?: boolean;
  // Called as the mirror walks the source tree. Updates are throttled by the
  // caller; runBackup itself fires every file + every phase boundary.
  onProgress?: (p: BackupProgress) => void;
}

const TYPES: ReadonlyArray<Exclude<ArtifactType, "all">> = ["skill", "agent", "command"];

export const PROJECTS_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  "cache",
  "debug",
  "session-env",
  "shell-snapshots",
  "telemetry",
  "usage-data",
  "statsig",
  "downloads",
  "paste-cache",
  "ide",
  "channels",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
]);

export const ARTIFACT_EXCLUDE_DIRS: ReadonlySet<string> = new Set([".DS_Store"]);

// vercel-labs/skills layout reserves dot-prefixed top-level dirs (`.system`,
// `.curated`, `.experimental`) under `<tool>/skills/` for bundles shipped by
// the tool's installer. The app only manages user-installed skills, so skill
// mirrors skip those at the source root. (Sub-dirs further down still mirror
// normally — a user skill bundle with a `.git` inside is fair game.)
export const SKILL_TOP_LEVEL_EXCLUDE_PREFIXES: ReadonlyArray<string> = ["."];

interface ToolAcc {
  counts: BackupCounts;
  entries: BackupEntry[];
  errors: string[];
}

export async function runBackup(opts: RunBackupOptions): Promise<BackupManifest> {
  const { fs, paths, joiner, destination, tools, recentProjects, onProgress } = opts;
  const includeProjectsHistory = opts.includeProjectsHistory ?? true;

  // Per-tool accumulators so each tool's manifest can be written independently.
  // History (kind="project") is grouped under "claude" since that's where the
  // ~/.claude/projects/ tree lives. globalErrors collects errors from steps
  // that aren't tied to a single tool (e.g. manifest-write failures).
  const toolAccs = new Map<Tool, ToolAcc>();
  const globalErrors: string[] = [];
  function accFor(tool: Tool): ToolAcc {
    let a = toolAccs.get(tool);
    if (!a) {
      a = { counts: emptyCounts(), entries: [], errors: [] };
      toolAccs.set(tool, a);
    }
    return a;
  }
  // Pre-create entries for every requested tool so an empty per-tool manifest
  // still gets written (signals "we ran this tool, found nothing changed").
  for (const t of tools) accFor(t);

  const touched = new Set<string>();
  let filesProcessed = 0;
  let filesCopied = 0;
  let bytesProcessed = 0;
  let bytesCopied = 0;
  let phase = "starting";
  function notify() {
    if (!onProgress) return;
    onProgress({ phase, filesProcessed, filesCopied, bytesProcessed, bytesCopied });
  }
  function setPhase(p: string) {
    phase = p;
    notify();
  }
  function recordFile(bytes: number, copied: boolean) {
    filesProcessed += 1;
    bytesProcessed += bytes;
    if (copied) {
      filesCopied += 1;
      bytesCopied += bytes;
    }
    notify();
  }

  // The destination IS the backup root. Each tool gets its own
  // <tool>_backup/ subdirectory and its own LAST_BACKUP.json inside it, so
  // two backup runs for different tools can execute concurrently without
  // racing on a shared manifest. Prune is constrained to only walk the
  // top-level subdirectories WE create (claude_backup/, codex_backup/, …)
  // so sibling files in the destination are never touched.
  // Note: we deliberately do NOT ensureDir(backupRoot) here. The user picked
  // the folder via the system dialog, so it already exists. Tauri's fs scope
  // only matches our tool-named subdirs — the root itself is intentionally
  // outside scope to keep us from poking at sibling user files. Subsequent
  // ensureDir(<root>/<tool>_backup/<scope>/<type>) creates the needed
  // parents recursively within scope.
  const backupRoot = destination;
  // Track only the top-level dirs we touch, so prune knows which to walk.
  const topLevelDirs = new Set<string>();

  // 0) Sweep orphan *.tmp.<digits> files left over by previously-interrupted
  // atomicWrite calls (typically when the cloud sync daemon briefly held a
  // write lock). Sweep is also constrained to subtrees we own.
  setPhase("cleaning orphan tmps");

  // toolDir(tool) → "<backupRoot>/<tool>_backup". Single source of truth so a
  // future rename only touches one line.
  async function toolDir(tool: Tool): Promise<string> {
    return joiner.join(backupRoot, toolBackupSubdir(tool));
  }

  // 1) Artifacts: tools × global scope.
  for (const tool of tools) {
    const acc = accFor(tool);
    for (const type of TYPES) {
      const sourceDir = await resolveArtifactDir(paths, tool, "global", type);
      if (!sourceDir) continue;
      setPhase(`${tool} · global · ${type}`);
      topLevelDirs.add(await toolDir(tool));
      const destDir = await joiner.join(await toolDir(tool), "global", type);
      const relBase = ["artifacts", tool, "global", type].join("/");
      const meta = { tool, scope: "global" as const, type };
      const single = singleFileArtifact(tool, type);
      if (single) {
        const sourceFile = await joiner.join(sourceDir, single);
        const destFile = await joiner.join(destDir, single);
        await mirrorSingleFile({
          fs,
          source: sourceFile,
          dest: destFile,
          relBase: `${relBase}/${single}`,
          kind: "artifact",
          meta,
          entries: acc.entries,
          counts: acc.counts,
          touched,
          errors: acc.errors,
          recordFile,
        });
      } else {
        await mirrorTree({
          fs,
          joiner,
          source: sourceDir,
          dest: destDir,
          relBase,
          kind: "artifact",
          meta,
          excludeDirNames: ARTIFACT_EXCLUDE_DIRS,
          topLevelExcludePrefixes:
            type === "skill" ? SKILL_TOP_LEVEL_EXCLUDE_PREFIXES : undefined,
          entries: acc.entries,
          counts: acc.counts,
          touched,
          errors: acc.errors,
          recordFile,
        });
      }
    }
  }

  // 2) Artifacts: tools × project scope, per recentProjects.
  for (const projectRoot of recentProjects) {
    const projectSlug = slugify(projectRoot);
    setPhase(`project · ${projectSlug}`);
    for (const tool of tools) {
      const acc = accFor(tool);
      for (const type of TYPES) {
        // Claude reads project artifacts from BOTH <root>/.agents/<sub>/ and
        // <root>/.claude/<sub>/. Mirror both — listClaudeArtifacts merges
        // them, so we owe the user the same coverage in the backup.
        const sourceDirs = await resolveProjectArtifactDirs(
          paths,
          joiner,
          tool,
          type,
          projectRoot,
        );
        for (const sourceDir of sourceDirs) {
          if (!sourceDir) continue;
          topLevelDirs.add(await toolDir(tool));
          const destDir = await joiner.join(
            await toolDir(tool),
            "project",
            projectSlug,
            type,
          );
          const relBase = ["artifacts", tool, "project", projectSlug, type].join("/");
          const meta = { tool, scope: "project" as const, type, projectRoot };
          const single = singleFileArtifact(tool, type);
          if (single) {
            const sourceFile = await joiner.join(sourceDir, single);
            const destFile = await joiner.join(destDir, single);
            await mirrorSingleFile({
              fs,
              source: sourceFile,
              dest: destFile,
              relBase: `${relBase}/${single}`,
              kind: "artifact",
              meta,
              entries: acc.entries,
              counts: acc.counts,
              touched,
              errors: acc.errors,
              recordFile,
            });
          } else {
            await mirrorTree({
              fs,
              joiner,
              source: sourceDir,
              dest: destDir,
              relBase,
              kind: "artifact",
              meta,
              excludeDirNames: ARTIFACT_EXCLUDE_DIRS,
              topLevelExcludePrefixes:
                type === "skill" ? SKILL_TOP_LEVEL_EXCLUDE_PREFIXES : undefined,
              entries: acc.entries,
              counts: acc.counts,
              touched,
              errors: acc.errors,
              recordFile,
            });
          }
        }
      }
    }
  }

  // 2b) CLAUDE.md memory files — Claude Code reads ~/.claude/CLAUDE.md at
  // startup (user memory) and <project>/CLAUDE.md per project. They aren't
  // inside .claude/agents/ but we group them with the agent backup so the
  // user gets both halves of "Claude's instructions" in one place.
  if (tools.includes("claude")) {
    const acc = accFor("claude");
    const home = await paths.homeDir();
    const globalMemorySrc = await joiner.join(home, ".claude", "CLAUDE.md");
    setPhase("claude · global · CLAUDE.md");
    topLevelDirs.add(await toolDir("claude"));
    const globalMemoryDest = await joiner.join(
      await toolDir("claude"),
      "global",
      "agent",
      "CLAUDE.md",
    );
    await mirrorSingleFile({
      fs,
      source: globalMemorySrc,
      dest: globalMemoryDest,
      relBase: "artifacts/claude/global/agent/CLAUDE.md",
      kind: "artifact",
      meta: { tool: "claude", scope: "global", type: "agent" },
      entries: acc.entries,
      counts: acc.counts,
      touched,
      errors: acc.errors,
      recordFile,
    });
    for (const projectRoot of recentProjects) {
      const projectSlug = slugify(projectRoot);
      const src = await joiner.join(projectRoot, "CLAUDE.md");
      const dest = await joiner.join(
        await toolDir("claude"),
        "project",
        projectSlug,
        "agent",
        "CLAUDE.md",
      );
      setPhase(`claude · project · ${projectSlug} · CLAUDE.md`);
      topLevelDirs.add(await toolDir("claude"));
      await mirrorSingleFile({
        fs,
        source: src,
        dest,
        relBase: `artifacts/claude/project/${projectSlug}/agent/CLAUDE.md`,
        kind: "artifact",
        meta: { tool: "claude", scope: "project", type: "agent", projectRoot },
        entries: acc.entries,
        counts: acc.counts,
        touched,
        errors: acc.errors,
        recordFile,
      });
    }
  }

  // 3) ~/.claude/projects/ — conversation history + MEMORY.md, mirrored to
  // <dest>/claude_backup/history (folder name renamed from "projects" to
  // disambiguate from the user's actual project roots).
  if (includeProjectsHistory && tools.includes("claude")) {
    const acc = accFor("claude");
    const home = await paths.homeDir();
    const projectsSrc = await joiner.join(home, ".claude", "projects");
    if (await fs.exists(projectsSrc)) {
      setPhase("claude · history");
      topLevelDirs.add(await toolDir("claude"));
      const projectsDest = await joiner.join(await toolDir("claude"), "history");
      await mirrorTree({
        fs,
        joiner,
        source: projectsSrc,
        dest: projectsDest,
        relBase: "claude/history",
        kind: "project",
        meta: {},
        excludeDirNames: PROJECTS_EXCLUDE_DIRS,
        entries: acc.entries,
        counts: acc.counts,
        touched,
        errors: acc.errors,
        recordFile,
      });
    }
  }

  // 4) Final phases.

  // 4a) Sweep orphan tmp files only under our own subtrees.
  for (const dir of topLevelDirs) {
    await sweepOrphanTmps({ fs, joiner, dir, errors: globalErrors });
  }

  // 4b) Bounded delete pass — walk only the top-level subtrees we created
  // this run (claude_backup/, codex_backup/, …). Sibling files in the user's
  // destination folder are never touched. Removed counts attribute to the
  // tool whose subtree they belonged to.
  setPhase("pruning destination");
  for (const tool of toolAccs.keys()) {
    const acc = toolAccs.get(tool)!;
    const dir = await toolDir(tool);
    if (!topLevelDirs.has(dir)) continue;
    await pruneUntouched({
      fs,
      joiner,
      dir,
      touched,
      counts: acc.counts,
      errors: acc.errors,
    });
  }

  // 5) Write per-tool manifests. Each tool's manifest lives inside its own
  // <tool>_backup/ subdir, so concurrent runs for different tools never race
  // on the same file.
  setPhase("writing manifest");
  const generatedAt = Date.now();
  for (const [tool, acc] of toolAccs) {
    const dir = await toolDir(tool);
    // If this tool didn't get touched at all (e.g. requested but every
    // resolveArtifactDir returned null), skip writing a manifest into a
    // directory we never created — that would force-create an empty subdir.
    if (!topLevelDirs.has(dir)) continue;
    // mirrorTree short-circuits when the source doesn't exist on disk, so
    // dir may have been added to topLevelDirs without ever being created.
    // ensureDir guards atomicWrite (which writes to <dir>/LAST_BACKUP.json
    // .tmp.<n>) from "No such file or directory" on those tools — a common
    // case now that the registry resolves a path for every supported agent
    // even when the user hasn't installed it.
    try {
      await ensureDir(fs, dir);
    } catch (e) {
      globalErrors.push(`manifest ${tool}: ${describeError(e)}`);
      continue;
    }
    const m: BackupManifest = {
      version: MANIFEST_VERSION,
      generatedAt,
      destination,
      counts: acc.counts,
      entries: acc.entries,
      errors: acc.errors,
    };
    const manifestPath = await joiner.join(dir, MANIFEST_FILENAME);
    try {
      await atomicWrite(fs, manifestPath, serializeManifest(m));
    } catch (e) {
      globalErrors.push(`manifest ${tool}: ${describeError(e)}`);
    }
  }

  // Combined manifest returned to the caller — used by the in-app UI to render
  // a single unified view across all tools.
  const combined: BackupManifest = {
    version: MANIFEST_VERSION,
    generatedAt,
    destination,
    counts: sumCounts(Array.from(toolAccs.values()).map((a) => a.counts)),
    entries: Array.from(toolAccs.values()).flatMap((a) => a.entries),
    errors: [
      ...Array.from(toolAccs.values()).flatMap((a) => a.errors),
      ...globalErrors,
    ],
  };
  return combined;
}

function sumCounts(parts: BackupCounts[]): BackupCounts {
  const out = emptyCounts();
  for (const c of parts) {
    out.added += c.added;
    out.changed += c.changed;
    out.removed += c.removed;
    out.unchanged += c.unchanged;
  }
  return out;
}

export interface MirrorContext {
  fs: FsAdapter;
  joiner: PathJoiner;
  source: string;
  dest: string;
  relBase: string;
  kind: "artifact" | "project";
  meta: {
    tool?: Tool;
    scope?: Exclude<Scope, "all">;
    type?: Exclude<ArtifactType, "all">;
    projectRoot?: string;
  };
  excludeDirNames: ReadonlySet<string>;
  // Names starting with any of these prefixes are skipped at the top level
  // of the source tree only (rel === ""). Subdirectories pass through
  // unchanged. Used to drop tool-shipped category dirs (`.system`, …) from
  // skill backups without accidentally filtering dot dirs nested inside a
  // user bundle.
  topLevelExcludePrefixes?: ReadonlyArray<string>;
  entries: BackupEntry[];
  counts: { added: number; changed: number; removed: number; unchanged: number };
  touched: Set<string>;
  errors: string[];
  recordFile?: (bytes: number, copied: boolean) => void;
}

export async function mirrorTree(ctx: MirrorContext): Promise<void> {
  // Tauri's fs scope rejects paths outside its allow-list with a thrown
  // "forbidden path" error rather than returning false. Treat that as a
  // skip-with-warning so one out-of-scope tool can't abort the whole backup.
  let present: boolean;
  try {
    present = await ctx.fs.exists(ctx.source);
  } catch (e) {
    ctx.errors.push(`skipped ${ctx.source}: ${describeError(e)}`);
    return;
  }
  if (!present) return;
  await ensureDir(ctx.fs, ctx.dest);
  await walk(ctx, ctx.source, ctx.dest, "");
}

async function walk(
  ctx: MirrorContext,
  source: string,
  dest: string,
  rel: string,
): Promise<void> {
  let kids;
  try {
    kids = await safeReadDir(ctx.fs, source);
  } catch (e) {
    ctx.errors.push(`readdir ${source}: ${describeError(e)}`);
    return;
  }
  // Track every directory we touch so the prune pass keeps it.
  ctx.touched.add(dest);
  const isTopLevel = rel === "";
  const topPrefixes = isTopLevel ? ctx.topLevelExcludePrefixes : undefined;
  for (const entry of kids) {
    if (ctx.excludeDirNames.has(entry.name)) continue;
    if (entry.name.startsWith(".tmp.")) continue;
    if (topPrefixes?.some((p) => entry.name.startsWith(p))) continue;
    const childSrc = await ctx.joiner.join(source, entry.name);
    const childDest = await ctx.joiner.join(dest, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      await ensureDir(ctx.fs, childDest);
      await walk(ctx, childSrc, childDest, childRel);
    } else if (entry.isFile) {
      await mirrorFile(ctx, childSrc, childDest, childRel);
    }
  }
}

async function mirrorFile(
  ctx: MirrorContext,
  source: string,
  dest: string,
  rel: string,
): Promise<void> {
  let bytes: Uint8Array;
  try {
    if (!ctx.fs.readFile) throw new Error("FsAdapter.readFile not implemented");
    bytes = await ctx.fs.readFile(source);
  } catch (e) {
    ctx.errors.push(`read ${source}: ${describeError(e)}`);
    return;
  }
  const sourceHash = await sha256Bytes(bytes);
  ctx.touched.add(dest);

  const destExists = await ctx.fs.exists(dest);
  let needsWrite = !destExists;
  if (destExists) {
    try {
      if (!ctx.fs.readFile) throw new Error("FsAdapter.readFile not implemented");
      const destBytes = await ctx.fs.readFile(dest);
      const destHash = await sha256Bytes(destBytes);
      needsWrite = destHash !== sourceHash;
    } catch {
      needsWrite = true;
    }
  }

  let status: "added" | "changed" | "unchanged" = "unchanged";
  if (needsWrite) {
    try {
      if (!ctx.fs.writeFile) throw new Error("FsAdapter.writeFile not implemented");
      await ctx.fs.writeFile(dest, bytes);
      if (destExists) {
        ctx.counts.changed += 1;
        status = "changed";
      } else {
        ctx.counts.added += 1;
        status = "added";
      }
    } catch (e) {
      ctx.errors.push(`write ${dest}: ${describeError(e)}`);
      return;
    }
  } else {
    ctx.counts.unchanged += 1;
  }

  ctx.entries.push({
    kind: ctx.kind,
    tool: ctx.meta.tool,
    scope: ctx.meta.scope,
    type: ctx.meta.type,
    projectRoot: ctx.meta.projectRoot,
    relPath: `${ctx.relBase}/${rel}`,
    destPath: dest,
    sha256: sourceHash,
    bytes: bytes.byteLength,
    status,
  });
  ctx.recordFile?.(bytes.byteLength, status !== "unchanged");
}

interface PruneOptions {
  fs: FsAdapter;
  joiner: PathJoiner;
  dir: string;
  touched: Set<string>;
  counts: { added: number; changed: number; removed: number; unchanged: number };
  errors: string[];
}

async function pruneUntouched(opts: PruneOptions): Promise<void> {
  const { fs, joiner, dir, touched, counts, errors } = opts;
  if (!(await fs.exists(dir))) return;
  let kids;
  try {
    kids = await safeReadDir(fs, dir);
  } catch (e) {
    errors.push(`prune readdir ${dir}: ${describeError(e)}`);
    return;
  }
  for (const entry of kids) {
    const child = await joiner.join(dir, entry.name);
    if (entry.isDirectory) {
      await pruneUntouched({ fs, joiner, dir: child, touched, counts, errors });
      // After recursion, remove the directory if it's now empty AND wasn't
      // touched by this run.
      if (!touched.has(child)) {
        const remaining = await safeReadDir(fs, child);
        if (remaining.length === 0) {
          try {
            await fs.remove(child, { recursive: true });
          } catch {
            // Cloud sync daemons (OneDrive, Dropbox) briefly hold locks on
            // directories during sync — empty-dir removal commonly returns
            // "Operation not permitted" until the lock clears. The next
            // backup will retry rmdir; meanwhile the empty subtree is
            // invisible to the user.
          }
        }
      }
    } else if (entry.isFile) {
      // The manifest file itself is rewritten after pruning, so always keep it.
      if (entry.name === MANIFEST_FILENAME) continue;
      // .DS_Store is Finder's metadata file, created when the user browses
      // the destination in Finder. We didn't put it there, so don't try to
      // remove it (Tauri's fs scope rejects dotfile paths anyway).
      if (entry.name === ".DS_Store") continue;
      if (!touched.has(child)) {
        try {
          await fs.remove(child);
          counts.removed += 1;
        } catch (e) {
          // OneDrive/Dropbox briefly lock files during sync — surface the
          // error but don't fail the whole backup. Orphaned .tmp.<ts> files
          // from a previously-interrupted atomicWrite are silenced; they're
          // transient and will be retried on the next run.
          if (!/\.tmp\.\d+$/.test(entry.name)) {
            errors.push(`rm ${child}: ${describeError(e)}`);
          }
        }
      }
    }
  }
}

// Mirror what listClaudeArtifacts does: for Claude project scope it scans
// BOTH <projectRoot>/.agents/<sub>/ and <projectRoot>/.claude/<sub>/. For all
// other tools, fall back to the single dir resolveArtifactDir returns.
async function resolveProjectArtifactDirs(
  paths: PathResolverDeps,
  joiner: PathJoiner,
  tool: Tool,
  type: Exclude<ArtifactType, "all">,
  projectRoot: string,
): Promise<string[]> {
  if (tool === "claude") {
    const sub =
      type === "skill" ? "skills" : type === "agent" ? "agents" : "commands";
    return [
      await joiner.join(projectRoot, ".agents", sub),
      await joiner.join(projectRoot, ".claude", sub),
    ];
  }
  const dir = await resolveArtifactDir(paths, tool, "project", type, projectRoot);
  return dir ? [dir] : [];
}

// resolveArtifactDir returns the project root itself for codex/agent (because
// AGENTS.md lives at the root, not in a subdir). Walking that recursively
// would mirror the user's entire project tree. For these tool/type pairs we
// back up only the named single file instead.
function singleFileArtifact(tool: Tool, type: Exclude<ArtifactType, "all">): string | null {
  if (tool === "codex" && type === "agent") return "AGENTS.md";
  return null;
}

export interface SingleFileContext {
  fs: FsAdapter;
  source: string;
  dest: string;
  relBase: string;
  kind: "artifact" | "project";
  meta: {
    tool?: Tool;
    scope?: Exclude<Scope, "all">;
    type?: Exclude<ArtifactType, "all">;
    projectRoot?: string;
  };
  entries: BackupEntry[];
  counts: { added: number; changed: number; removed: number; unchanged: number };
  touched: Set<string>;
  errors: string[];
  recordFile?: (bytes: number, copied: boolean) => void;
}

export async function mirrorSingleFile(ctx: SingleFileContext): Promise<void> {
  let present: boolean;
  try {
    present = await ctx.fs.exists(ctx.source);
  } catch (e) {
    ctx.errors.push(`skipped ${ctx.source}: ${describeError(e)}`);
    return;
  }
  if (!present) return;
  // Mark the parent dest directory as touched so the prune pass keeps it.
  const lastSep = Math.max(ctx.dest.lastIndexOf("/"), ctx.dest.lastIndexOf("\\"));
  if (lastSep > 0) {
    const parent = ctx.dest.slice(0, lastSep);
    ctx.touched.add(parent);
    await ensureDir(ctx.fs, parent);
  }
  let bytes: Uint8Array;
  try {
    if (!ctx.fs.readFile) throw new Error("FsAdapter.readFile not implemented");
    bytes = await ctx.fs.readFile(ctx.source);
  } catch (e) {
    ctx.errors.push(`read ${ctx.source}: ${describeError(e)}`);
    return;
  }
  const sourceHash = await sha256Bytes(bytes);
  ctx.touched.add(ctx.dest);

  const destExists = await ctx.fs.exists(ctx.dest);
  let needsWrite = !destExists;
  if (destExists) {
    try {
      if (!ctx.fs.readFile) throw new Error("FsAdapter.readFile not implemented");
      const destBytes = await ctx.fs.readFile(ctx.dest);
      needsWrite = (await sha256Bytes(destBytes)) !== sourceHash;
    } catch {
      needsWrite = true;
    }
  }
  let status: "added" | "changed" | "unchanged" = "unchanged";
  if (needsWrite) {
    try {
      if (!ctx.fs.writeFile) throw new Error("FsAdapter.writeFile not implemented");
      await ctx.fs.writeFile(ctx.dest, bytes);
      if (destExists) {
        ctx.counts.changed += 1;
        status = "changed";
      } else {
        ctx.counts.added += 1;
        status = "added";
      }
    } catch (e) {
      ctx.errors.push(`write ${ctx.dest}: ${describeError(e)}`);
      return;
    }
  } else {
    ctx.counts.unchanged += 1;
  }
  ctx.entries.push({
    kind: ctx.kind,
    tool: ctx.meta.tool,
    scope: ctx.meta.scope,
    type: ctx.meta.type,
    projectRoot: ctx.meta.projectRoot,
    relPath: ctx.relBase,
    destPath: ctx.dest,
    sha256: sourceHash,
    bytes: bytes.byteLength,
    status,
  });
  ctx.recordFile?.(bytes.byteLength, status !== "unchanged");
}

function slugify(p: string): string {
  return p
    .replace(/[\\/]+$/, "")
    .replace(/[\\:/]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+/g, "-");
}

interface SweepOptions {
  fs: FsAdapter;
  joiner: PathJoiner;
  dir: string;
  errors: string[];
}

// Recursively delete any leftover `*.tmp.<digits>` files under dir. These are
// orphans from atomicWrite calls that died mid-rename — they're safe to
// remove because they only ever contained transient pending bytes, never the
// authoritative copy. We swallow OneDrive lock failures silently because the
// next sweep will pick them up.
async function sweepOrphanTmps(opts: SweepOptions): Promise<void> {
  const { fs, joiner, dir, errors } = opts;
  if (!(await fs.exists(dir))) return;
  let kids;
  try {
    kids = await safeReadDir(fs, dir);
  } catch (e) {
    errors.push(`sweep readdir ${dir}: ${describeError(e)}`);
    return;
  }
  for (const entry of kids) {
    const child = await joiner.join(dir, entry.name);
    if (entry.isDirectory) {
      await sweepOrphanTmps({ fs, joiner, dir: child, errors });
    } else if (entry.isFile && /\.tmp\.\d+$/.test(entry.name)) {
      try {
        await fs.remove(child);
      } catch {
        // Best-effort. OneDrive may briefly lock the file; we'll catch it
        // on the next backup.
      }
    }
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

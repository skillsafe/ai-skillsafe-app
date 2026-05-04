import type { ArtifactType, MarkdownArtifact, Scope, Tool } from "../artifacts/types";
import { atomicWrite, ensureDir, type FsAdapter } from "../fs";
import { resolveArtifactDir, type PathResolverDeps } from "../paths";
import {
  deriveBackupRoot,
  emptyCounts,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  parseManifest,
  serializeManifest,
  toolBackupSubdir,
  type BackupCounts,
  type BackupEntry,
  type BackupManifest,
  type BackupStats,
  type RecentChange,
} from "./manifest";
import {
  mirrorSingleFile,
  mirrorTree,
  type PathJoiner,
} from "./runBackup";

const ARTIFACT_EXCLUDE_DIRS = new Set([".DS_Store"]);

export interface BackupOneArtifactOptions {
  fs: FsAdapter;
  paths: PathResolverDeps;
  joiner: PathJoiner;
  destination: string;
  artifact: MarkdownArtifact;
  // Required for scope==="project" or scope==="lockfile"; ignored for global.
  projectRoot?: string;
}

export async function backupOneArtifact(opts: BackupOneArtifactOptions): Promise<BackupStats> {
  const { fs, joiner, destination, artifact, projectRoot } = opts;
  const tool = artifact.tool;
  const scope = narrowScope(artifact.scope);
  const type = narrowType(artifact.type);
  if (scope === "project" && !projectRoot) {
    throw new Error("backupOneArtifact: projectRoot is required for project scope");
  }

  // Logical path inside the manifest still uses just the tool name (no
  // _backup suffix) — that's an identifier for the BackupBrowser, not a
  // filesystem location. The on-disk layout uses <tool>_backup/.
  const relLayout: string[] = [tool];
  const fsLayout: string[] = [toolBackupSubdir(tool)];
  if (scope === "global") {
    relLayout.push("global");
    fsLayout.push("global");
  } else {
    relLayout.push("project", slugify(projectRoot!));
    fsLayout.push("project", slugify(projectRoot!));
  }
  relLayout.push(type);
  fsLayout.push(type);

  const relBaseDir = ["artifacts", ...relLayout].join("/");
  const destBaseDir = await joinAll(joiner, destination, ...fsLayout);

  const errors: string[] = [];
  const entries: BackupEntry[] = [];
  const counts = emptyCounts();
  const touched = new Set<string>();
  const meta = { tool, scope, type, projectRoot } as const;

  let dropPrefix: string;

  if (artifact.isBundle) {
    if (!artifact.bundleDir) {
      throw new Error("backupOneArtifact: bundle artifact missing bundleDir");
    }
    const bundleName = artifact.name;
    const destBundleDir = await joiner.join(destBaseDir, bundleName);
    await ensureDir(fs, destBundleDir);
    dropPrefix = `${relBaseDir}/${bundleName}/`;
    await mirrorTree({
      fs,
      joiner,
      source: artifact.bundleDir,
      dest: destBundleDir,
      relBase: `${relBaseDir}/${bundleName}`,
      kind: "artifact",
      meta,
      excludeDirNames: ARTIFACT_EXCLUDE_DIRS,
      entries,
      counts,
      touched,
      errors,
    });
  } else {
    const fileName = baseName(artifact.path);
    const destFile = await joiner.join(destBaseDir, fileName);
    await ensureDir(fs, destBaseDir);
    dropPrefix = `${relBaseDir}/${fileName}`;
    await mirrorSingleFile({
      fs,
      source: artifact.path,
      dest: destFile,
      relBase: `${relBaseDir}/${fileName}`,
      kind: "artifact",
      meta,
      entries,
      counts,
      touched,
      errors,
    });
  }

  const manifest = await mergeManifest({
    fs,
    joiner,
    destination,
    manifestDir: await joiner.join(destination, toolBackupSubdir(tool)),
    dropPrefix,
    isExactPrefix: !artifact.isBundle,
    addEntries: entries,
    addErrors: errors,
  });
  // Stats reflect THIS run only — counts, bytes, recentChanges, and errors
  // come from `entries`/`counts`/`errors` we just produced. The merged
  // manifest (which can contain stale entries from prior runs of other
  // artifacts) is only used for the persisted destination/timestamp.
  return statsForThisRun({ manifest, entries, counts, errors });
}

function statsForThisRun(args: {
  manifest: BackupManifest;
  entries: ReadonlyArray<BackupEntry>;
  counts: BackupCounts;
  errors: ReadonlyArray<string>;
}): BackupStats {
  const { manifest, entries, counts, errors } = args;
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const recentChanges: RecentChange[] = entries
    .filter((e) => e.status !== "unchanged")
    .slice(0, 30)
    .map((e) => ({ relPath: e.relPath, destPath: e.destPath, status: e.status, bytes: e.bytes }));
  return {
    generatedAt: manifest.generatedAt,
    counts: { ...counts },
    errorSamples: errors.slice(0, 10),
    recentChanges,
    backupRoot: deriveBackupRoot(manifest.destination),
    totalBytes,
    errorCount: errors.length,
  };
}

export interface RestoreFile {
  // Absolute path to the file in the backup destination.
  source: string;
  // Path within the bundle (e.g. "SKILL.md", "assets/foo.png"). For single
  // files, this is the destination filename (e.g. "rule.md", "AGENTS.md").
  relInItem: string;
}

export interface RestoreFromBackupOptions {
  fs: FsAdapter;
  paths: PathResolverDeps;
  joiner: PathJoiner;
  tool: Tool;
  scope: Exclude<Scope, "all" | "lockfile">;
  type: Exclude<ArtifactType, "all">;
  projectRoot?: string;
  // Bundle name for skill-style artifacts; omit for single-file artifacts.
  bundleName?: string;
  files: ReadonlyArray<RestoreFile>;
}

export interface RestoreResult {
  targetDir: string;
  written: string[];
}

export async function restoreFromBackup(
  opts: RestoreFromBackupOptions,
): Promise<RestoreResult> {
  const { fs, paths, joiner, tool, scope, type, projectRoot, bundleName, files } = opts;
  if (scope === "project" && !projectRoot) {
    throw new Error("restoreFromBackup: projectRoot required for project scope");
  }
  if (files.length === 0) {
    throw new Error("restoreFromBackup: nothing to restore");
  }
  const baseDir = await resolveArtifactDir(paths, tool, scope, type, projectRoot);
  if (!baseDir) {
    throw new Error(`restoreFromBackup: no artifact dir for ${tool}/${scope}/${type}`);
  }
  const targetRoot = bundleName ? await joiner.join(baseDir, bundleName) : baseDir;
  await ensureDir(fs, targetRoot);

  const written: string[] = [];
  for (const file of files) {
    const segments = file.relInItem.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    if (segments.includes("..") || file.relInItem.startsWith("/")) {
      throw new Error(`Refusing unsafe restore path: ${file.relInItem}`);
    }
    // CLAUDE.md is grouped with the "agent" type for the backup UI but the
    // file actually lives outside the agents/ subdirectory: at ~/.claude/
    // CLAUDE.md (global) or <project>/CLAUDE.md (project). Redirect the
    // restore so it lands in the right place.
    const claudeMemoryDest = await claudeMemoryRestoreDest({
      tool,
      scope,
      type,
      projectRoot,
      relInItem: file.relInItem,
      paths,
      joiner,
    });
    if (claudeMemoryDest) {
      await ensureDir(fs, parentOf(claudeMemoryDest));
      await copyFile(fs, file.source, claudeMemoryDest);
      written.push(claudeMemoryDest);
      continue;
    }
    let cursor = targetRoot;
    for (let i = 0; i < segments.length - 1; i++) {
      cursor = await joiner.join(cursor, segments[i]);
      await ensureDir(fs, cursor);
    }
    const dest = await joiner.join(cursor, segments[segments.length - 1]);
    await copyFile(fs, file.source, dest);
    written.push(dest);
  }
  return { targetDir: targetRoot, written };
}

interface ClaudeMemoryRestoreArgs {
  tool: Tool;
  scope: Exclude<Scope, "all" | "lockfile">;
  type: Exclude<ArtifactType, "all">;
  projectRoot?: string;
  relInItem: string;
  paths: PathResolverDeps;
  joiner: PathJoiner;
}

async function claudeMemoryRestoreDest(args: ClaudeMemoryRestoreArgs): Promise<string | null> {
  const { tool, scope, type, projectRoot, relInItem, paths, joiner } = args;
  if (tool !== "claude" || type !== "agent") return null;
  if (relInItem !== "CLAUDE.md") return null;
  if (scope === "global") {
    const home = await paths.homeDir();
    return joiner.join(home, ".claude", "CLAUDE.md");
  }
  if (scope === "project" && projectRoot) {
    return joiner.join(projectRoot, "CLAUDE.md");
  }
  return null;
}

function parentOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : path;
}

async function copyFile(fs: FsAdapter, source: string, dest: string): Promise<void> {
  if (fs.readFile && fs.writeFile) {
    const bytes = await fs.readFile(source);
    await fs.writeFile(dest, bytes);
    return;
  }
  const text = await fs.readTextFile(source);
  await atomicWrite(fs, dest, text);
}

interface MergeManifestArgs {
  fs: FsAdapter;
  joiner: PathJoiner;
  // User's chosen backup destination — recorded in the manifest's
  // `destination` field so the BackupBrowser can find sibling tool manifests.
  destination: string;
  // Directory the manifest file actually lives in (the per-tool subdir,
  // e.g. <destination>/claude_backup). The mergeManifest call also needs
  // this dir to exist for atomicWrite to succeed.
  manifestDir: string;
  // For bundles: trailing-slash prefix of relPaths to drop ("artifacts/.../foo/").
  // For single files: the exact relPath of the file (isExactPrefix=true).
  dropPrefix: string;
  isExactPrefix: boolean;
  addEntries: BackupEntry[];
  addErrors: string[];
}

async function mergeManifest(args: MergeManifestArgs): Promise<BackupManifest> {
  const {
    fs,
    joiner,
    destination,
    manifestDir,
    dropPrefix,
    isExactPrefix,
    addEntries,
    addErrors,
  } = args;
  const manifestPath = await joiner.join(manifestDir, MANIFEST_FILENAME);
  let existing: BackupManifest | null = null;
  if (await fs.exists(manifestPath)) {
    try {
      const text = await fs.readTextFile(manifestPath);
      existing = parseManifest(text);
    } catch {
      existing = null;
    }
  }
  const surviving = existing
    ? existing.entries.filter((e) =>
        isExactPrefix ? e.relPath !== dropPrefix : !e.relPath.startsWith(dropPrefix),
      )
    : [];
  const mergedEntries = [...surviving, ...addEntries];
  // Counts must be derived from the surviving entry set so a no-op rerun
  // reports the actual current state (added=0 if nothing changed) instead
  // of the lifetime sum of every prior addCounts. Old code merged counts
  // additively, so the manifest's `counts.added` grew on every per-skill
  // rerun even when `entries[*].status` correctly showed unchanged.
  // `removed` isn't tracked by the per-artifact path (no pruning happens
  // here), so preserve whatever the last full runBackup recorded.
  const derived = countsFromEntries(mergedEntries);
  const removed = existing ? existing.counts.removed : 0;
  const merged: BackupManifest = {
    version: MANIFEST_VERSION,
    generatedAt: Date.now(),
    destination,
    counts: { ...derived, removed },
    entries: mergedEntries,
    errors: existing ? [...existing.errors, ...addErrors] : addErrors,
  };
  await atomicWrite(fs, manifestPath, serializeManifest(merged));
  return merged;
}

function countsFromEntries(entries: ReadonlyArray<BackupEntry>): BackupCounts {
  const out = emptyCounts();
  for (const e of entries) {
    if (e.status === "added") out.added += 1;
    else if (e.status === "changed") out.changed += 1;
    else if (e.status === "unchanged") out.unchanged += 1;
  }
  return out;
}

function narrowScope(s: Scope): Exclude<Scope, "all" | "lockfile"> {
  if (s === "all") return "global";
  if (s === "lockfile") return "project";
  return s;
}

function narrowType(t: ArtifactType): Exclude<ArtifactType, "all"> {
  return t === "all" ? "skill" : t;
}

async function joinAll(joiner: PathJoiner, ...parts: string[]): Promise<string> {
  let cur = parts[0];
  for (let i = 1; i < parts.length; i++) {
    cur = await joiner.join(cur, parts[i]);
  }
  return cur;
}

function baseName(path: string): string {
  const segs = path.split(/[\\/]/);
  return segs[segs.length - 1] || path;
}

// Mirror runBackup's slugify so single-artifact backup lands in the same
// project subdir a full backup would use.
function slugify(p: string): string {
  return p
    .replace(/[\\/]+$/, "")
    .replace(/[\\:/]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+/g, "-");
}

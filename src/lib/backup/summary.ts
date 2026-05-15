// Walks a backup destination after the bash/PowerShell script finishes,
// computes a per-file manifest, diffs it against the previous run, and
// writes the new manifest to the caller-supplied path. Previously this
// landed at <dest>/LAST_BACKUP.json (alongside the backup files); the
// app-level flow now writes it to the per-machine state dir
// (`appPaths.manifestPath`) so each machine maintains its own view, the
// shared cloud-synced backup folder stays uncluttered, and the manifest is
// reachable without round-tripping through possibly-offline cloud storage.

import { ensureDir, safeReadDir, type FsAdapter } from "../fs";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  parseManifest,
  serializeManifest,
  summarize,
  type BackupEntry,
  type BackupManifest,
  type BackupStats,
} from "./manifest";
import type { ArtifactType, Tool } from "../artifacts/types";
import { slotForPath } from "./dataTypes";

// Maps the resolved slot to the BackupBrowser's legacy artifact-type filter.
// Only the three classic types map; other slots leave `type` undefined and
// the browser groups them by their slot directly.
const SLOT_TO_TYPE: Record<string, Exclude<ArtifactType, "all">> = {
  skills: "skill",
  agents: "agent",
  commands: "command",
};

function inferEntryFields(relPath: string): {
  tool?: Tool;
  scope?: "global";
  type?: Exclude<ArtifactType, "all">;
} {
  const parts = relPath.split("/");
  if (parts.length === 0 || !parts[0]) return {};
  const tool = parts[0];
  const slot = slotForPath(relPath);
  // Bash-script backups always source from the user's global config dirs,
  // so scope is always "global" — there's no per-project mode here.
  const type = slot ? SLOT_TO_TYPE[slot] : undefined;
  return { tool, scope: "global", type };
}

interface BuildOptions {
  fs: FsAdapter;
  joiner: { join: (...parts: string[]) => Promise<string> };
  destination: string;
  generatedAt: number;
  // Absolute path the manifest should be written to. Callers pass the
  // per-machine app-state path (see appPaths.manifestPath); legacy callers
  // and tests can still target `<destination>/LAST_BACKUP.json` directly.
  manifestPath: string;
}

/** Files we wrote ourselves and which therefore should not appear as backup
 *  entries in their own manifest. Only matched at the root of the backup
 *  destination — see `ROOT_ONLY_SKIP` vs `ANY_DEPTH_SKIP` below. */
const SKIP_FILES = new Set([
  MANIFEST_FILENAME,
]);

/** Finder drops a `.DS_Store` into every folder a user opens, including
 *  arbitrarily deep ones inside the backup tree. Filter at every depth so
 *  these don't pollute the file listing. */
const ANY_DEPTH_SKIP = new Set([".DS_Store"]);

const TIME_TOLERANCE_MS = 2000;

export async function buildAndWriteManifest(
  opts: BuildOptions,
): Promise<{ manifest: BackupManifest; stats: BackupStats }> {
  const manifestPath = opts.manifestPath;
  await ensureParentDir(opts.fs, opts.joiner, manifestPath);
  const prev = await readPrevious(opts.fs, manifestPath);
  const prevByPath = new Map<string, BackupEntry>(
    (prev?.entries ?? []).map((e) => [e.relPath, e]),
  );

  const entries: BackupEntry[] = [];
  await walk(opts.fs, opts.joiner, opts.destination, "", entries);

  const counts = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  const currentPaths = new Set<string>();
  for (const e of entries) {
    currentPaths.add(e.relPath);
    const old = prevByPath.get(e.relPath);
    if (!old) {
      e.status = "added";
      counts.added++;
    } else if (old.bytes !== e.bytes) {
      e.status = "changed";
      counts.changed++;
    } else {
      e.status = "unchanged";
      counts.unchanged++;
    }
  }
  for (const oldPath of prevByPath.keys()) {
    if (!currentPaths.has(oldPath)) counts.removed++;
  }

  // Order: added/changed first so the "Recent changes" list in the UI shows
  // meaningful entries even when most files are unchanged.
  entries.sort((a, b) => {
    const pri = (e: BackupEntry) => (e.status === "added" ? 0 : e.status === "changed" ? 1 : 2);
    return pri(a) - pri(b) || a.relPath.localeCompare(b.relPath);
  });

  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    generatedAt: opts.generatedAt,
    destination: opts.destination,
    counts,
    entries,
    errors: [],
  };

  try {
    await opts.fs.writeTextFile(manifestPath, serializeManifest(manifest));
  } catch (e) {
    // Manifest write isn't load-bearing for the data copy — files already
    // mirrored — but losing the manifest means the BackupPanel's Recent
    // changes / "Last backup …" line can't update until the next run.
    // Surface the error in manifest.errors so the panel's "N errors" pill
    // explains why instead of silently appearing frozen.
    const msg = e instanceof Error ? e.message : String(e);
    manifest.errors.push(`manifest write failed: ${manifestPath}: ${msg}`);
    // eslint-disable-next-line no-console
    console.error("[skillsafe-backup] manifest write failed", manifestPath, e);
  }

  return { manifest, stats: summarize(manifest) };
}

async function readPrevious(
  fs: FsAdapter,
  manifestPath: string,
): Promise<BackupManifest | null> {
  try {
    if (!(await fs.exists(manifestPath))) return null;
    const text = await fs.readTextFile(manifestPath);
    return parseManifest(text);
  } catch {
    return null;
  }
}

async function walk(
  fs: FsAdapter,
  joiner: { join: (...parts: string[]) => Promise<string> },
  root: string,
  rel: string,
  out: BackupEntry[],
): Promise<void> {
  const dir = rel ? await joiner.join(root, rel) : root;
  const entries = await safeReadDir(fs, dir);
  for (const e of entries) {
    if (e.name === "." || e.name === "..") continue;
    if (ANY_DEPTH_SKIP.has(e.name)) continue;
    if (rel === "" && SKIP_FILES.has(e.name)) continue;
    // The master/ folder is browsed live by loadMasterAsBackupEntries —
    // it is not part of any tool's backup snapshot. Skip the whole tree
    // so its files don't get misclassified as a stray "master"-tool
    // artifact in the BackupBrowser (or, worse, ingested with paths
    // that may have changed across the legacy `<tool>--<name>` →
    // `<tool>/<name>` filename migration).
    if (rel === "" && e.name === "master") continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const childAbs = await joiner.join(root, childRel);
    if (e.isDirectory) {
      await walk(fs, joiner, root, childRel, out);
      continue;
    }
    if (!e.isFile) continue;
    let stat: { size: number; mtimeMs: number } | null = null;
    try {
      const s = await fs.stat(childAbs);
      stat = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      continue;
    }
    const inferred = inferEntryFields(childRel);
    out.push({
      kind: "artifact",
      tool: inferred.tool,
      scope: inferred.scope,
      type: inferred.type,
      relPath: childRel,
      destPath: childAbs,
      sha256: "",
      bytes: stat.size,
      status: "added",
    });
  }
}

// The manifest now lives in the app state dir, which the app may not have
// created yet on first launch (or on a machine where the user has only just
// installed). Ensure the parent dir exists before atomicWrite tries to land
// the file.
async function ensureParentDir(
  fs: FsAdapter,
  joiner: { join: (...parts: string[]) => Promise<string> },
  fullPath: string,
): Promise<void> {
  const parts = fullPath.split(/[\\/]/);
  if (parts.length <= 1) return;
  const parent = parts.slice(0, -1).join(fullPath.includes("\\") ? "\\" : "/");
  if (!parent) return;
  try {
    await ensureDir(fs, parent);
  } catch {
    /* best-effort; writeTextFile will surface a useful error */
  }
  // `joiner` is unused for the parent computation but kept on the signature
  // so the helper can grow into a more platform-aware version later.
  void joiner;
}

// Visible to tests so they can compare bytes-only diff without going through
// a full backup execution.
export const __testing = { walk, TIME_TOLERANCE_MS };

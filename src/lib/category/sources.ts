// Resolves the on-disk source paths for a backup data-type so the main UI
// can render the same files the backup would mirror. Mirrors the resolution
// logic in src/lib/backup/generateScripts.ts:315-328 but at runtime (live
// adapter) rather than embedded in a generated shell script.
//
// Keeps backup and browse aligned: if you change what gets mirrored, this
// module decides what the user can browse, and the same exclusion sets
// (PROJECTS_EXCLUDE_DIRS etc., exported from runBackup.ts) gate both.

import { agents } from "../agents/registry";
import type { Attachment, Tool } from "../artifacts/types";
import { extraSourceFor } from "../backup/dataTypes";
import type { DataType } from "../backup/dataTypes";
import {
  ARTIFACT_EXCLUDE_DIRS,
  PROJECTS_EXCLUDE_DIRS,
  SKILL_TOP_LEVEL_EXCLUDE_PREFIXES,
} from "../backup/runBackup";
import { safeExists, safeReadDir, type FsAdapter } from "../fs";
import type { PathResolverDeps } from "../paths";

export interface PathJoiner {
  join: (...parts: string[]) => Promise<string>;
}

/** A concrete on-disk path the browser should scan, plus the relative
 *  segment the DataType referenced. For `kind:"tree"` entries `isFile` is
 *  false and we walk the directory; for `kind:"files"` we surface one
 *  Attachment per file. */
export interface CategoryRoot {
  /** Display name for the root inside the tree (e.g. "projects", "settings.json"). */
  name: string;
  /** Absolute on-disk path. */
  path: string;
  /** True iff the DataType.paths entry refers to a single file. */
  isFile: boolean;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return trimmed;
  return trimmed.slice(0, idx);
}

/** Resolves the tool's config root the same way the backup script does:
 *  for an extra source, `extra.configRoot(deps)`; otherwise the parent of
 *  the agent's globalSkillsDir. */
async function configRootFor(tool: Tool, deps: PathResolverDeps): Promise<string | null> {
  const extra = extraSourceFor(tool);
  if (extra) return extra.configRoot(deps);
  const cfg = agents[tool];
  if (!cfg) return null;
  const skillsDir = await cfg.globalSkillsDir(deps);
  return parentDir(skillsDir);
}

/** Platform-aware Claude Desktop config dir. Mirrors the hardcoded paths
 *  used by the backup script generator (generateScripts.ts:530-555). */
async function claudeDesktopRoot(deps: PathResolverDeps): Promise<string> {
  const home = await deps.homeDir();
  // Use a runtime probe rather than relying on a platform plugin so the
  // browse path works in any host. Tauri's homedir already encodes the OS
  // family (Windows = backslashes); fall back to macOS path style on POSIX.
  if (home.includes("\\")) {
    // Windows: %APPDATA% = ~/AppData/Roaming
    return deps.join(home, "AppData", "Roaming", "Claude");
  }
  return deps.join(home, "Library", "Application Support", "Claude");
}

/** Lists immediate dir children of `dir` as CategoryRoots so the browser
 *  can render each one as its own top-level entry and walk them in
 *  parallel. Used to skip the noise-wrapper folder (e.g. ~/.claude/
 *  projects/) for the History & Memory category. */
async function expandOneLevel(
  fs: FsAdapter,
  joiner: PathJoiner,
  dir: string,
): Promise<CategoryRoot[]> {
  const entries = await safeReadDir(fs, dir);
  const out: CategoryRoot[] = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const p = await joiner.join(dir, entry.name);
    let isDir = entry.isDirectory;
    let isFile = entry.isFile;
    if (!isDir && !isFile && entry.isSymlink) {
      try {
        const s = await fs.stat(p);
        isDir = s.isDirectory;
        isFile = s.isFile;
      } catch {
        continue;
      }
    }
    if (isDir || isFile) {
      out.push({ name: entry.name, path: p, isFile });
    }
  }
  // Files first so any top-level memory file (e.g. MEMORY.md) renders before
  // the per-project dirs that lazily stream in.
  out.sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? -1 : 1));
  return out;
}

/** Data-type ids whose single wrapper dir is just noise — we flatten one
 *  level so each child shows up as a top-level row and streams in
 *  independently. `memory` wraps per-project history dirs under
 *  ~/.claude/projects/; `plugins` wraps per-plugin dirs under
 *  ~/.claude/plugins/. */
const FLATTEN_WRAPPER_IDS: ReadonlySet<string> = new Set(["memory", "plugins"]);

/** Resolves the absolute paths the category browser should display for a
 *  (tool, DataType) pair. Returns [] when the source doesn't exist on this
 *  machine — callers render an empty state. */
export async function resolveCategoryRoots(
  fs: FsAdapter,
  tool: Tool,
  dt: DataType,
  deps: PathResolverDeps,
  joiner: PathJoiner,
): Promise<CategoryRoot[]> {
  if (dt.kind === "claude_desktop") {
    const root = await claudeDesktopRoot(deps);
    const out: CategoryRoot[] = [];
    for (const filename of dt.paths) {
      const p = await joiner.join(root, filename);
      if (await safeExists(fs, p)) out.push({ name: filename, path: p, isFile: true });
    }
    return out;
  }

  const cfgRoot = await configRootFor(tool, deps);
  if (!cfgRoot) return [];
  const out: CategoryRoot[] = [];
  for (const rel of dt.paths) {
    const abs = rel === "." ? cfgRoot : await joiner.join(cfgRoot, rel);
    if (!(await safeExists(fs, abs))) continue;
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    out.push({
      name: rel === "." ? (cfgRoot.split(/[\\/]/).pop() ?? cfgRoot) : rel,
      path: abs,
      isFile: stat.isFile,
    });
  }

  // Single-dir wrapper categories (memory) get flattened one level so the
  // user sees their actual entries instead of one collapsed parent that
  // hides everything behind a click.
  if (
    FLATTEN_WRAPPER_IDS.has(dt.id) &&
    out.length === 1 &&
    !out[0]!.isFile
  ) {
    return expandOneLevel(fs, joiner, out[0]!.path);
  }

  return out;
}

interface WalkOptions {
  fs: FsAdapter;
  joiner: PathJoiner;
  /** Top-level dirs to skip at any depth (e.g. cache, node_modules). */
  excludeDirNames: ReadonlySet<string>;
  /** Names matched at the immediate skill source root (`.system`, etc.).
   *  Skill-only. */
  topLevelExcludePrefixes?: ReadonlyArray<string>;
}

async function walkDir(
  dir: string,
  opts: WalkOptions,
  isRoot: boolean,
): Promise<Attachment[]> {
  const entries = await safeReadDir(opts.fs, dir);
  // Walk siblings in parallel — for ~/.claude/projects/<id>/*.jsonl this
  // turns dozens of serial stats into one batched Promise.all and brings
  // first-paint down from seconds to ~100ms on typical Claude history.
  const tasks = entries.map(async (entry): Promise<Attachment | null> => {
    if (opts.excludeDirNames.has(entry.name)) return null;
    if (
      isRoot &&
      opts.topLevelExcludePrefixes?.some((p) => entry.name.startsWith(p))
    ) {
      return null;
    }
    const path = await opts.joiner.join(dir, entry.name);
    let isDir = entry.isDirectory;
    let isFile = entry.isFile;
    if (!isDir && !isFile && entry.isSymlink) {
      try {
        const s = await opts.fs.stat(path);
        isDir = s.isDirectory;
        isFile = s.isFile;
      } catch {
        return null;
      }
    }
    if (isFile) {
      const stat = await opts.fs.stat(path).catch(() => null);
      return { name: entry.name, path, size: stat?.size ?? 0, isDir: false };
    }
    if (isDir) {
      return {
        name: entry.name,
        path,
        size: 0,
        isDir: true,
        children: await walkDir(path, opts, false),
      };
    }
    return null;
  });
  const out = (await Promise.all(tasks)).filter((x): x is Attachment => x !== null);
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return out;
}

function makeWalkOptions(
  fs: FsAdapter,
  joiner: PathJoiner,
  dataTypeId: string,
): WalkOptions {
  return {
    fs,
    joiner,
    excludeDirNames: new Set<string>([
      ...PROJECTS_EXCLUDE_DIRS,
      ...ARTIFACT_EXCLUDE_DIRS,
    ]),
    topLevelExcludePrefixes:
      dataTypeId === "skills" ? SKILL_TOP_LEVEL_EXCLUDE_PREFIXES : undefined,
  };
}

/** Builds an Attachment[] tree for the resolved roots, applying the same
 *  exclusion sets the backup mirror uses (so what the user browses matches
 *  what backup mirrors). `dataTypeId` selects which exclusion profile to
 *  apply — skills get the `.system`/`.curated`/`.experimental` top-level
 *  filter; memory + everything else gets the noise-dir blacklist. */
export async function buildCategoryTree(
  fs: FsAdapter,
  joiner: PathJoiner,
  roots: CategoryRoot[],
  dataTypeId: string,
): Promise<Attachment[]> {
  const opts = makeWalkOptions(fs, joiner, dataTypeId);
  // Walk every root in parallel — the cost dominates the user-visible
  // latency for History & Memory where each project dir is a separate
  // subtree.
  const tasks = roots.map(async (root): Promise<Attachment> => {
    if (root.isFile) {
      const stat = await fs.stat(root.path).catch(() => null);
      return { name: root.name, path: root.path, size: stat?.size ?? 0, isDir: false };
    }
    return {
      name: root.name,
      path: root.path,
      size: 0,
      isDir: true,
      children: await walkDir(root.path, opts, true),
    };
  });
  return Promise.all(tasks);
}

/** Walks a single subtree on demand — used by lazy-loaded category modes
 *  where the top-level rows render immediately and per-folder contents
 *  load when the user expands them. Returns the same Attachment[] a
 *  full walk would produce, applying the standard exclusion sets. */
export async function walkCategorySubtree(
  fs: FsAdapter,
  joiner: PathJoiner,
  dir: string,
  dataTypeId: string,
): Promise<Attachment[]> {
  const opts = makeWalkOptions(fs, joiner, dataTypeId);
  // isRoot=false because the caller is one level inside an already-rooted
  // top-level entry — skill `.system` filter only applies at the very root.
  return walkDir(dir, opts, false);
}

/** Streaming variant: emits the tree progressively so the UI can render
 *  the top level immediately, then re-render as each root's subtree
 *  finishes walking. Resolves with the final tree (same value as the last
 *  `onUpdate` call). Use this from React components; call sites that just
 *  want the finished tree (tests, scripts) can use `buildCategoryTree`. */
export async function buildCategoryTreeProgressive(
  fs: FsAdapter,
  joiner: PathJoiner,
  roots: CategoryRoot[],
  dataTypeId: string,
  onUpdate: (tree: Attachment[]) => void,
): Promise<Attachment[]> {
  const opts = makeWalkOptions(fs, joiner, dataTypeId);
  // Phase 1: empty placeholders so the tree renders top-level rows
  // straight away. We mark dirs with `children: undefined` so the
  // renderer can show a "loading" affordance per row if desired; today
  // TreeView treats undefined as "no expand arrow", so we use an empty
  // array — collapsible but empty until filled.
  const partial: Attachment[] = roots.map((r) =>
    r.isFile
      ? { name: r.name, path: r.path, size: 0, isDir: false }
      : { name: r.name, path: r.path, size: 0, isDir: true, children: [] },
  );
  onUpdate([...partial]);

  // Phase 2: stat the file roots (quick, batched).
  await Promise.all(
    roots.map(async (r, i) => {
      if (!r.isFile) return;
      const stat = await fs.stat(r.path).catch(() => null);
      partial[i] = { name: r.name, path: r.path, size: stat?.size ?? 0, isDir: false };
    }),
  );
  onUpdate([...partial]);

  // Phase 3: walk every directory root in parallel; emit after each one
  // settles so the user sees results trickle in.
  await Promise.all(
    roots.map(async (r, i) => {
      if (r.isFile) return;
      const children = await walkDir(r.path, opts, true);
      partial[i] = {
        name: r.name,
        path: r.path,
        size: 0,
        isDir: true,
        children,
      };
      onUpdate([...partial]);
    }),
  );

  return partial;
}

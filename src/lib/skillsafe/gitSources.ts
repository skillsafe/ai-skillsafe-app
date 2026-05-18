// Persistent registry of Git-sourced skill installs. Lives next to
// skills-lock.json in the user's home dir (resolved via PathResolverDeps so
// tests can swap it out). Each entry records enough provenance to:
//   - re-download the same content later ("Check for updates")
//   - detect drift (the on-disk SKILL.md hash diverging from what we wrote)
//   - distinguish a pinned-by-SHA install from a track-the-branch install.

import { z } from "zod";
import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir } from "../fs";
import type { PathJoiner } from "../artifacts/skill";

export const gitSourceEntry = z.object({
  owner: z.string(),
  repo: z.string(),
  /** Branch, tag, or commit SHA actually used at install time. */
  ref: z.string(),
  /** True if the user pinned an exact commit. */
  pinned: z.boolean().optional(),
  /** Resolved commit SHA if known. */
  commit: z.string().optional(),
  /** Optional SKILL.md subpath inside the repo. */
  subpath: z.string().optional(),
  /** Tool the bundle was installed for (e.g. "claude"). */
  tool: z.string(),
  /** "global" or "project". */
  scope: z.string(),
  /** Project root when scope=project. */
  projectRoot: z.string().optional(),
  /** Absolute install dir. */
  targetDir: z.string(),
  /** sha-256 of SKILL.md at install time. */
  installedHash: z.string(),
  /** Epoch ms. */
  installedAt: z.number(),
});

export type GitSourceEntry = z.infer<typeof gitSourceEntry>;

export const gitSourcesFile = z.object({
  version: z.literal(1),
  /** Keyed by the installed bundle name. */
  sources: z.record(z.string(), gitSourceEntry),
});

export type GitSourcesFile = z.infer<typeof gitSourcesFile>;

const EMPTY: GitSourcesFile = { version: 1, sources: {} };

export async function gitSourcesPath(pj: PathJoiner, home: string): Promise<string> {
  // Same parent as skills-lock.json by convention. Tests and Tauri both
  // resolve the user's home dir before calling.
  return pj.join(home, ".skillsafe", "git-sources.json");
}

export async function readGitSources(
  fs: FsAdapter,
  path: string,
): Promise<GitSourcesFile> {
  try {
    if (!(await fs.exists(path))) return { ...EMPTY };
    const raw = await fs.readTextFile(path);
    return gitSourcesFile.parse(JSON.parse(raw));
  } catch {
    return { ...EMPTY };
  }
}

export async function writeGitSources(
  fs: FsAdapter,
  pj: PathJoiner,
  path: string,
  file: GitSourcesFile,
): Promise<void> {
  const parent = await parentDir(pj, path);
  await ensureDir(fs, parent);
  await atomicWrite(fs, path, JSON.stringify(file, null, 2) + "\n");
}

async function parentDir(_pj: PathJoiner, path: string): Promise<string> {
  // Quick path-string parent without an extra Tauri round-trip — works on
  // both POSIX and Windows separators.
  const sep = path.includes("\\") ? "\\" : "/";
  const idx = path.lastIndexOf(sep);
  return idx > 0 ? path.slice(0, idx) : path;
}

export async function upsertGitSource(
  fs: FsAdapter,
  pj: PathJoiner,
  path: string,
  name: string,
  entry: GitSourceEntry,
): Promise<GitSourcesFile> {
  const cur = await readGitSources(fs, path);
  cur.sources[name] = entry;
  await writeGitSources(fs, pj, path, cur);
  return cur;
}

export async function removeGitSource(
  fs: FsAdapter,
  pj: PathJoiner,
  path: string,
  name: string,
): Promise<GitSourcesFile> {
  const cur = await readGitSources(fs, path);
  if (!(name in cur.sources)) return cur;
  delete cur.sources[name];
  await writeGitSources(fs, pj, path, cur);
  return cur;
}

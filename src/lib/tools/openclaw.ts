import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact } from "../artifacts/types";
import { listSkillBundles } from "../artifacts/skill";
import { type PathResolverDeps } from "../paths";

export async function listOpenclawArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  // OpenClaw only publishes a skill bundle format right now.
  if (opts.type !== "skill") return [];

  const dirs: string[] = [];
  if (opts.scope === "project" && opts.projectRoot) {
    dirs.push(await pj.join(opts.projectRoot, "skills"));
    dirs.push(await pj.join(opts.projectRoot, ".agents", "skills"));
  } else if (opts.scope === "global") {
    const home = await paths.homeDir();
    dirs.push(await pj.join(home, ".openclaw", "skills"));
    dirs.push(await pj.join(home, ".agents", "skills"));
  } else {
    // lockfile scope: mirror Claude's pattern (callers handle lockfile drift via the project root)
    if (opts.projectRoot) {
      dirs.push(await pj.join(opts.projectRoot, "skills"));
      dirs.push(await pj.join(opts.projectRoot, ".agents", "skills"));
    }
  }

  const out: MarkdownArtifact[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const bundles = await listSkillBundles(fs, pj, dir, "openclaw", opts.scope);
    for (const b of bundles) {
      if (b.bundleDir && seen.has(b.bundleDir)) continue;
      if (b.bundleDir) seen.add(b.bundleDir);
      out.push(b);
    }
  }
  return out;
}

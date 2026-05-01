import type { FsAdapter } from "../fs";
import { safeReadDir } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact } from "../artifacts/types";
import { listSkillBundles } from "../artifacts/skill";
import { type PathResolverDeps } from "../paths";

// Hermes (https://hermes-agent.nousresearch.com) stores agentskills.io-style
// SKILL.md bundles under ~/.hermes/skills/. Bundles can sit directly under
// skills/ OR be nested one level under a category directory:
//   ~/.hermes/skills/<skill>/SKILL.md
//   ~/.hermes/skills/<category>/<skill>/SKILL.md
// We list both shapes and de-duplicate by bundle path.
export async function listHermesArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  if (opts.type !== "skill") return [];
  if (opts.scope === "lockfile") return [];

  const home = await paths.homeDir();
  const root =
    opts.scope === "project" && opts.projectRoot
      ? await pj.join(opts.projectRoot, ".hermes", "skills")
      : await pj.join(home, ".hermes", "skills");

  const out: MarkdownArtifact[] = [];
  const seen = new Set<string>();
  // Top-level bundles.
  for (const b of await listSkillBundles(fs, pj, root, "hermes", opts.scope)) {
    if (b.bundleDir && seen.has(b.bundleDir)) continue;
    if (b.bundleDir) seen.add(b.bundleDir);
    out.push(b);
  }
  // Category-nested bundles: any direct child of root that lacks a SKILL.md
  // is treated as a category directory and scanned one level deeper.
  const entries = await safeReadDir(fs, root);
  for (const entry of entries) {
    if (!entry.isDirectory && !entry.isSymlink) continue;
    const childDir = await pj.join(root, entry.name);
    const childSkill = await pj.join(childDir, "SKILL.md");
    if (await fs.exists(childSkill)) continue;
    for (const b of await listSkillBundles(fs, pj, childDir, "hermes", opts.scope)) {
      if (b.bundleDir && seen.has(b.bundleDir)) continue;
      if (b.bundleDir) seen.add(b.bundleDir);
      out.push(b);
    }
  }
  return out;
}

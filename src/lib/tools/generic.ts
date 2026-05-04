import type { FsAdapter } from "../fs";
import { safeExists, safeReadDir } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import { listSkillBundles } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact, Tool } from "../artifacts/types";
import { getAgentConfig } from "../agents/registry";
import { resolveArtifactDir, type PathResolverDeps } from "../paths";

// Generic skill discovery for any registry-known agent. Mirrors vercel-labs/
// skills' install layout: `<projectRoot>/<skillsDir>` for project scope and
// `<globalSkillsDir>` for global. Skills are SKILL.md bundles.
export async function listGenericSkills(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  // The registry only describes skill discovery — agent/command types are
  // not a concept for these tools.
  if (opts.type !== "skill") return [];
  const cfg = getAgentConfig(opts.tool);
  if (!cfg) return [];

  const root = await resolveArtifactDir(
    paths,
    opts.tool,
    opts.scope,
    "skill",
    opts.projectRoot,
  );
  if (!root) return [];

  return scanSkillBundles(fs, pj, root, opts.tool, opts.scope);
}

// vercel-labs/skills uses leading-dot directories like `.system`, `.curated`,
// and `.experimental` as *category prefixes* — parents of bundles, not
// bundles themselves (see vercel-labs/skills/src/skills.ts PRIORITY_PREFIXES).
// A `.system/SKILL.md` left at the root would otherwise read as a single
// 45-file bundle named ".system", which is surprising in the UI.
function isCategoryDir(name: string): boolean {
  return name.startsWith(".");
}

// Some agents store bundles either directly under skillsDir/ OR one level
// nested under a category directory (Hermes / vercel-labs/skills both use
// this). We scan both shapes generically and de-duplicate by bundle path,
// so non-nested layouts simply produce no extra results.
async function scanSkillBundles(
  fs: FsAdapter,
  pj: PathJoiner,
  root: string,
  tool: Tool,
  scope: ListOptions["scope"],
): Promise<MarkdownArtifact[]> {
  const out: MarkdownArtifact[] = [];
  const seen = new Set<string>();

  // Top-level bundles. Skip dot-prefixed children — those are category
  // directories per the vercel-labs/skills convention; the recursive pass
  // below walks into them looking for the real bundles.
  for (const b of await listSkillBundles(fs, pj, root, tool, scope)) {
    if (!b.bundleDir) continue;
    if (isCategoryDir(basename(b.bundleDir))) continue;
    if (seen.has(b.bundleDir)) continue;
    seen.add(b.bundleDir);
    out.push(b);
  }

  const entries = await safeReadDir(fs, root);
  for (const entry of entries) {
    if (!entry.isDirectory && !entry.isSymlink) continue;
    const childDir = await pj.join(root, entry.name);
    if (!isCategoryDir(entry.name)) {
      // Non-dot dirs already get listed by the top-level pass when they
      // hold a SKILL.md. If they don't, fall through to the nested scan
      // (Hermes' `<root>/<category>/<skill>/SKILL.md` layout).
      const childSkill = await pj.join(childDir, "SKILL.md");
      if (await safeExists(fs, childSkill)) continue;
    }
    for (const b of await listSkillBundles(fs, pj, childDir, tool, scope)) {
      if (b.bundleDir && seen.has(b.bundleDir)) continue;
      if (b.bundleDir) seen.add(b.bundleDir);
      out.push(b);
    }
  }

  return out;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

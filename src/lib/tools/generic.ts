import type { FsAdapter } from "../fs";
import { safeExists, safeReadDir } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import { listSkillBundles } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact, Tool } from "../artifacts/types";
import { resolveSkillScanDirs, type PathResolverDeps } from "../paths";

// Generic skill discovery for any registry-known agent. Scans every
// directory the agent reads — the primary tool-specific path plus any
// `extraSkillsDirs` / `extraGlobalSkillsDirs` declared in the registry
// (e.g. the cross-tool `.agents/skills` convention, XDG
// `~/.config/agents/skills`). Bundles are deduped by canonical path so a
// skill installed once doesn't appear twice when its dir is listed by more
// than one alias.
export async function listGenericSkills(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  // The registry only describes skill discovery — agent/command types are
  // not a concept for these tools.
  if (opts.type !== "skill") return [];

  const dirs = await resolveSkillScanDirs(paths, opts.tool, opts.scope, opts.projectRoot);
  if (dirs.length === 0) return [];

  const out: MarkdownArtifact[] = [];
  const seen = new Set<string>();
  for (const root of dirs) {
    for (const b of await scanSkillBundles(fs, pj, root, opts.tool, opts.scope)) {
      if (b.bundleDir && seen.has(b.bundleDir)) continue;
      if (b.bundleDir) seen.add(b.bundleDir);
      out.push(b);
    }
  }
  return out;
}

// vercel-labs/skills uses leading-dot directories like `.system`, `.curated`,
// and `.experimental` as *category prefixes* — parents of bundles shipped by
// the tool's installer (system defaults). User-installed skills go directly
// at the top level, so we treat anything dot-prefixed as out-of-scope.
function isSystemCategoryDir(name: string): boolean {
  return name.startsWith(".");
}

// Some agents (Hermes) let users organize bundles one level under a non-dot
// category dir like `<root>/writing/<skill>/SKILL.md`. We descend into those
// to surface the real bundles, but never into dot-prefixed dirs — those hold
// system-shipped skills the app doesn't manage.
async function scanSkillBundles(
  fs: FsAdapter,
  pj: PathJoiner,
  root: string,
  tool: Tool,
  scope: ListOptions["scope"],
): Promise<MarkdownArtifact[]> {
  const out: MarkdownArtifact[] = [];
  const seen = new Set<string>();

  for (const b of await listSkillBundles(fs, pj, root, tool, scope)) {
    if (!b.bundleDir) continue;
    if (isSystemCategoryDir(basename(b.bundleDir))) continue;
    if (seen.has(b.bundleDir)) continue;
    seen.add(b.bundleDir);
    out.push(b);
  }

  const entries = await safeReadDir(fs, root);
  for (const entry of entries) {
    if (!entry.isDirectory && !entry.isSymlink) continue;
    if (isSystemCategoryDir(entry.name)) continue;
    const childDir = await pj.join(root, entry.name);
    const childSkill = await pj.join(childDir, "SKILL.md");
    if (await safeExists(fs, childSkill)) continue;
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

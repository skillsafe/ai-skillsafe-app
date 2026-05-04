import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact } from "../artifacts/types";
import { listMarkdownFiles, loadMarkdownFile } from "../artifacts/markdownFile";
import { listSkillBundles } from "../artifacts/skill";
import { resolveArtifactDir, type PathResolverDeps } from "../paths";
import { listGenericSkills } from "./generic";

export async function listClaudeArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  // Skill discovery follows vercel-labs/skills' rules via the registry:
  //   project → <projectRoot>/.claude/skills
  //   global  → ~/.claude/skills
  // In project scope we additionally scan <projectRoot>/.agents/skills to
  // pick up skills installed via `npx skills add` for tools that share the
  // universal `.agents/skills` location alongside Claude.
  if (opts.type === "skill") {
    const out = await listGenericSkills(fs, pj, paths, opts);
    if (opts.scope === "project" && opts.projectRoot) {
      const altDir = await pj.join(opts.projectRoot, ".agents", "skills");
      const seen = new Set(out.map((a) => a.bundleDir).filter(Boolean) as string[]);
      for (const b of await listSkillBundles(fs, pj, altDir, "claude", opts.scope)) {
        if (b.bundleDir && seen.has(b.bundleDir)) continue;
        if (b.bundleDir) seen.add(b.bundleDir);
        out.push(b);
      }
    }
    return out;
  }

  const out: MarkdownArtifact[] = [];

  // CLAUDE.md is the project/user memory file Claude Code reads at startup;
  // surface it as an "agent" artifact (parallel to Codex's AGENTS.md) so
  // edits flow through the same UI and the backup picks it up.
  if (opts.type === "agent") {
    const memoryPath = await claudeMemoryPath(pj, paths, opts.scope, opts.projectRoot);
    if (memoryPath && (await fs.exists(memoryPath))) {
      const artifact = await loadMarkdownFile(fs, memoryPath, "claude", opts.scope, "agent");
      out.push({ ...artifact, name: "CLAUDE.md" });
    }
  }

  const dir = await resolveArtifactDir(paths, "claude", opts.scope, opts.type, opts.projectRoot);
  if (dir) {
    out.push(...(await listMarkdownFiles(fs, pj, dir, "claude", opts.scope, opts.type)));
  }
  return out;
}

async function claudeMemoryPath(
  pj: PathJoiner,
  paths: PathResolverDeps,
  scope: ListOptions["scope"],
  projectRoot: string | undefined,
): Promise<string | null> {
  if (scope === "global") {
    const home = await paths.homeDir();
    return pj.join(home, ".claude", "CLAUDE.md");
  }
  if ((scope === "project" || scope === "lockfile") && projectRoot) {
    return pj.join(projectRoot, "CLAUDE.md");
  }
  return null;
}

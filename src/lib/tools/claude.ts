import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact } from "../artifacts/types";
import { listMarkdownFiles, loadMarkdownFile } from "../artifacts/markdownFile";
import { listSkillBundles } from "../artifacts/skill";
import { resolveArtifactDir, type PathResolverDeps } from "../paths";

export async function listClaudeArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  const dirs: string[] = [];
  if (opts.scope === "project" && opts.projectRoot) {
    const agentsAlt = await pj.join(opts.projectRoot, ".agents", subdir(opts.type));
    const claudeStd = await pj.join(opts.projectRoot, ".claude", subdir(opts.type));
    dirs.push(agentsAlt, claudeStd);
  } else {
    dirs.push(await resolveArtifactDir(paths, "claude", opts.scope, opts.type, opts.projectRoot));
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

  for (const dir of dirs) {
    if (opts.type === "skill") {
      out.push(...(await listSkillBundles(fs, pj, dir, "claude", opts.scope)));
    } else {
      out.push(...(await listMarkdownFiles(fs, pj, dir, "claude", opts.scope, opts.type)));
    }
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

function subdir(type: "skill" | "agent" | "command"): string {
  return type === "skill" ? "skills" : type === "agent" ? "agents" : "commands";
}

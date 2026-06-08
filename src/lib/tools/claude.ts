import type { FsAdapter } from "../fs";
import { safeReadDir } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact } from "../artifacts/types";
import { listMarkdownFiles, loadMarkdownFile } from "../artifacts/markdownFile";
import { resolveArtifactDir, type PathResolverDeps } from "../paths";
import { listGenericSkills } from "./generic";

export async function listClaudeArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  // Skill discovery is registry-driven. The Claude entry declares
  // `.agents/skills` as an extra project scan path so skills installed via
  // `npx skills add` (which writes to the cross-tool location) surface in
  // the Claude view too.
  if (opts.type === "skill") {
    let out = await listGenericSkills(fs, pj, paths, opts);
    if (opts.scope === "project" && opts.projectRoot) {
      // Drop bridge symlinks under .claude/skills/<n>. They point into
      // .agents/skills/<n>, which the generic lister now picks up as the
      // canonical entry — without this filter the same skill would show up
      // twice in the UI, and clicking delete on the symlink row would
      // recursive-rm through the link and wipe the real bundle.
      const claudeSkillsDir = await pj.join(opts.projectRoot, ".claude", "skills");
      const linkPaths = new Set<string>();
      for (const e of await safeReadDir(fs, claudeSkillsDir)) {
        if (e.isSymlink) linkPaths.add(await pj.join(claudeSkillsDir, e.name));
      }
      if (linkPaths.size > 0) {
        out = out.filter((a) => !a.bundleDir || !linkPaths.has(a.bundleDir));
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

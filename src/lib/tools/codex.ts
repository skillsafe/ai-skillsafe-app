import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact } from "../artifacts/types";
import { listMarkdownFiles, loadMarkdownFile } from "../artifacts/markdownFile";
import { type PathResolverDeps } from "../paths";

export async function listCodexArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  const home = await paths.homeDir();
  if (opts.type === "command") {
    const dir =
      opts.scope === "project" && opts.projectRoot
        ? await pj.join(opts.projectRoot, ".codex", "prompts")
        : await pj.join(home, ".codex", "prompts");
    return listMarkdownFiles(fs, pj, dir, "codex", opts.scope, "command");
  }
  if (opts.type === "agent") {
    const candidates =
      opts.scope === "project" && opts.projectRoot
        ? [await pj.join(opts.projectRoot, "AGENTS.md")]
        : [await pj.join(home, ".codex", "AGENTS.md")];
    const out: MarkdownArtifact[] = [];
    for (const c of candidates) {
      if (await fs.exists(c)) {
        out.push(await loadMarkdownFile(fs, c, "codex", opts.scope, "agent"));
      }
    }
    return out;
  }
  return [];
}

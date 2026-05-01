import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact } from "../artifacts/types";
import { listMarkdownFiles } from "../artifacts/markdownFile";
import { type PathResolverDeps } from "../paths";

export async function listCursorArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  if (opts.type !== "skill") return [];
  const home = await paths.homeDir();
  const dir =
    opts.scope === "project" && opts.projectRoot
      ? await pj.join(opts.projectRoot, ".cursor", "rules")
      : await pj.join(home, ".cursor", "rules");
  const md = await listMarkdownFiles(fs, pj, dir, "cursor", opts.scope, "skill", ".md");
  const mdc = await listMarkdownFiles(fs, pj, dir, "cursor", opts.scope, "skill", ".mdc");
  return [...md, ...mdc];
}

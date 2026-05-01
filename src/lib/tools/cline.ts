import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact } from "../artifacts/types";
import { listMarkdownFiles } from "../artifacts/markdownFile";
import { type PathResolverDeps } from "../paths";

export async function listClineArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  // Cline only has rules-equivalent artifacts; we map them onto "skill" type to
  // mirror Cursor's convention. Other types return empty.
  if (opts.type !== "skill") return [];
  // Cline has no lockfile concept.
  if (opts.scope === "lockfile") return [];
  const home = await paths.homeDir();
  // Per official Cline docs (https://docs.cline.bot/features/cline-rules):
  //  - Workspace: <project>/.clinerules/
  //  - Global (macOS/Linux/WSL): ~/Documents/Cline/Rules/
  //    (with ~/Cline/Rules/ as the documented Linux/WSL fallback)
  //  - Global (Windows): %USERPROFILE%\Documents\Cline\Rules\ — i.e. the
  //    same Documents/Cline/Rules layout, which `pj.join` produces with the
  //    correct platform separator at runtime.
  const dirs: string[] =
    opts.scope === "project" && opts.projectRoot
      ? [await pj.join(opts.projectRoot, ".clinerules")]
      : [
          await pj.join(home, "Documents", "Cline", "Rules"),
          await pj.join(home, "Cline", "Rules"),
        ];
  const out: MarkdownArtifact[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    // Cline processes both .md and .txt files in the rules directory.
    const md = await listMarkdownFiles(fs, pj, dir, "cline", opts.scope, "skill", ".md");
    const txt = await listMarkdownFiles(fs, pj, dir, "cline", opts.scope, "skill", ".txt");
    for (const a of [...md, ...txt]) {
      if (seen.has(a.path)) continue;
      seen.add(a.path);
      out.push(a);
    }
  }
  return out;
}

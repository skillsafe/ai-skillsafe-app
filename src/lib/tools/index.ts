import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact, Tool } from "../artifacts/types";
import type { PathResolverDeps } from "../paths";
import { listClaudeArtifacts } from "./claude";
import { listCodexArtifacts } from "./codex";
import { listCursorArtifacts } from "./cursor";
import { listOpenclawArtifacts } from "./openclaw";
import { listClineArtifacts } from "./cline";
import { listHermesArtifacts } from "./hermes";

export async function listArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  const dispatch: Record<Tool, typeof listClaudeArtifacts> = {
    claude: listClaudeArtifacts,
    codex: listCodexArtifacts,
    cursor: listCursorArtifacts,
    openclaw: listOpenclawArtifacts,
    cline: listClineArtifacts,
    hermes: listHermesArtifacts,
  };
  return dispatch[opts.tool](fs, pj, paths, opts);
}

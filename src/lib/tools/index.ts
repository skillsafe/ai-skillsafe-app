import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { ListOptions, MarkdownArtifact } from "../artifacts/types";
import type { PathResolverDeps } from "../paths";
import { listClaudeArtifacts } from "./claude";
import { listCodexArtifacts } from "./codex";
import { listGenericSkills } from "./generic";
import { isKnownAgent } from "../agents/registry";

// Dispatcher. Claude and Codex have agent/command artifact types in addition
// to skills (CLAUDE.md, AGENTS.md, .codex/prompts) — they get bespoke
// listers. Every other registered agent uses the generic skill lister, which
// consults the agent registry (mirrors vercel-labs/skills).
export async function listArtifacts(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  opts: ListOptions,
): Promise<MarkdownArtifact[]> {
  if (opts.tool === "claude") return listClaudeArtifacts(fs, pj, paths, opts);
  if (opts.tool === "codex") return listCodexArtifacts(fs, pj, paths, opts);
  if (!isKnownAgent(opts.tool)) return [];
  return listGenericSkills(fs, pj, paths, opts);
}

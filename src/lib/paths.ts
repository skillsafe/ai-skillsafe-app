import type { ArtifactType, Scope, Tool } from "./artifacts/types";
import { getAgentConfig } from "./agents/registry";

export interface PathResolverDeps {
  homeDir: () => Promise<string>;
  join: (...parts: string[]) => Promise<string>;
}

let homeCache: string | null = null;

export async function getHome(deps: PathResolverDeps): Promise<string> {
  if (homeCache) return homeCache;
  homeCache = await deps.homeDir();
  return homeCache;
}

export function resetHomeCache(): void {
  homeCache = null;
}

// Resolves the directory the lister scans for a given (tool, scope, type).
//
// Skill discovery is registry-driven and follows vercel-labs/skills' rules:
//   project scope → <projectRoot>/<agent.skillsDir>
//   global  scope → <agent.globalSkillsDir(deps)>
//
// Agent + Command artifact types are kept for tools that have them today —
// Claude (CLAUDE.md, .claude/agents, .claude/commands) and Codex (AGENTS.md,
// .codex/prompts). Every other tool returns "" for those types because the
// upstream registry is skill-only.
export async function resolveArtifactDir(
  deps: PathResolverDeps,
  tool: Tool,
  scope: Scope,
  type: ArtifactType,
  projectRoot?: string,
): Promise<string> {
  if (type === "all") {
    throw new Error("resolveArtifactDir: 'all' is a UI sentinel, narrow first");
  }

  // Skill discovery — handled identically for every registered agent.
  if (type === "skill") {
    const cfg = getAgentConfig(tool);
    if (!cfg) return "";
    if (scope === "global") return cfg.globalSkillsDir(deps);
    // project + lockfile both anchor on a project root.
    if (!projectRoot) return "";
    return deps.join(projectRoot, cfg.skillsDir);
  }

  // Below: agent + command types. Only Claude and Codex carry these.
  const home = await getHome(deps);

  if (tool === "claude") {
    if (scope === "project" && projectRoot) {
      return deps.join(projectRoot, ".agents", subdir(type));
    }
    return deps.join(home, ".claude", subdir(type));
  }

  if (tool === "codex") {
    if (type === "command") {
      return deps.join(scope === "global" ? home : projectRoot ?? home, ".codex", "prompts");
    }
    if (type === "agent") {
      // Single-file artifacts (AGENTS.md): callers append the filename.
      return scope === "global" ? deps.join(home, ".codex") : projectRoot ?? home;
    }
  }

  // Anything else: agent/command isn't a concept for this tool.
  return "";
}

function subdir(type: ArtifactType): string {
  switch (type) {
    case "skill":
      return "skills";
    case "agent":
      return "agents";
    case "command":
      return "commands";
    case "all":
      throw new Error("subdir: 'all' is a UI sentinel, not a concrete type");
  }
}

export function projectAgentsRoot(deps: PathResolverDeps, projectRoot: string): Promise<string> {
  return deps.join(projectRoot, ".agents");
}

export function lockfilePath(deps: PathResolverDeps, projectRoot: string): Promise<string> {
  return deps.join(projectRoot, "skills-lock.json");
}

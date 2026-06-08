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
    // Project-scope Claude commands/agents live alongside skills at
    // <project>/.claude/<subdir>/, NOT <project>/.agents/. Mirrors the
    // registry's skillsDir (".claude/skills") for the same tool.
    if (scope === "project" && projectRoot) {
      return deps.join(projectRoot, ".claude", subdir(type));
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

// Resolves the full list of directories the lister should scan for an
// agent's skills at the given scope — the primary (`globalSkillsDir` /
// `skillsDir`) plus any `extraGlobalSkillsDirs` / `extraSkillsDirs` declared
// in the registry. Duplicates and empty paths are dropped.
//
// Listing-only: `resolveArtifactDir` remains the source of truth for the
// canonical install/save/backup target.
export async function resolveSkillScanDirs(
  deps: PathResolverDeps,
  tool: Tool,
  scope: Scope,
  projectRoot?: string,
): Promise<string[]> {
  const cfg = getAgentConfig(tool);
  if (!cfg) return [];
  const dirs: string[] = [];
  if (scope === "global") {
    dirs.push(await cfg.globalSkillsDir(deps));
    for (const fn of cfg.extraGlobalSkillsDirs ?? []) dirs.push(await fn(deps));
  } else {
    if (!projectRoot) return [];
    dirs.push(await deps.join(projectRoot, cfg.skillsDir));
    for (const sub of cfg.extraSkillsDirs ?? []) {
      dirs.push(await deps.join(projectRoot, sub));
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
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

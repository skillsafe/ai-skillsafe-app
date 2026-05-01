import type { ArtifactType, Scope, Tool } from "./artifacts/types";

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

export async function resolveArtifactDir(
  deps: PathResolverDeps,
  tool: Tool,
  scope: Scope,
  type: ArtifactType,
  projectRoot?: string,
): Promise<string> {
  const home = await getHome(deps);
  const root =
    scope === "global"
      ? home
      : scope === "project"
        ? projectRoot ?? home
        : projectRoot ?? home;

  if (tool === "claude") {
    if (scope === "project" && projectRoot) {
      const agentsDir = await deps.join(projectRoot, ".agents", subdir(type));
      return agentsDir;
    }
    return deps.join(root, ".claude", subdir(type));
  }

  if (tool === "codex") {
    if (type === "command") return deps.join(root, ".codex", "prompts");
    if (type === "agent") return scope === "global" ? deps.join(root, ".codex") : root;
    return deps.join(root, ".codex", "skills");
  }

  if (tool === "cursor") {
    if (scope === "project" && projectRoot) {
      return deps.join(projectRoot, ".cursor", "rules");
    }
    return deps.join(root, ".cursor", "rules");
  }

  if (tool === "openclaw") {
    if (type !== "skill") return "";
    if (scope === "project" && projectRoot) {
      return deps.join(projectRoot, "skills");
    }
    return deps.join(root, ".openclaw", "skills");
  }

  if (tool === "cline") {
    if (type !== "skill") return deps.join(root, "Documents", "Cline", "Rules", "_unused");
    if (scope === "project" && projectRoot) {
      return deps.join(projectRoot, ".clinerules");
    }
    // Per Cline docs (https://docs.cline.bot/features/cline-rules) global
    // rules live under Documents/Cline/Rules on every platform — i.e.
    // ~/Documents/Cline/Rules on macOS/Linux/WSL and
    // %USERPROFILE%\Documents\Cline\Rules on Windows. The lister also
    // checks ~/Cline/Rules as a documented Linux/WSL fallback.
    return deps.join(root, "Documents", "Cline", "Rules");
  }

  if (tool === "hermes") {
    // Hermes only ships skills (agentskills.io-compatible bundles); other
    // types map nowhere. Skills live at ~/.hermes/skills, optionally nested
    // one level under a category directory.
    if (type !== "skill") return "";
    if (scope === "project" && projectRoot) {
      return deps.join(projectRoot, ".hermes", "skills");
    }
    return deps.join(root, ".hermes", "skills");
  }

  throw new Error(`unknown tool: ${tool satisfies never}`);
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
      // Sentinel only used in the UI; resolveArtifactDir narrows before calling.
      throw new Error("subdir: 'all' is a UI sentinel, not a concrete type");
  }
}

export function projectAgentsRoot(deps: PathResolverDeps, projectRoot: string): Promise<string> {
  return deps.join(projectRoot, ".agents");
}

export function lockfilePath(deps: PathResolverDeps, projectRoot: string): Promise<string> {
  return deps.join(projectRoot, "skills-lock.json");
}

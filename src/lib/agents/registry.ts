// Mirror of vercel-labs/skills' src/agents.ts agent registry.
//
// This is the single source of truth for which agents are supported and which
// directories the app scans for SKILL.md bundles. Project scope joins
// `skillsDir` onto a project root; global scope resolves `globalSkillsDir`
// against the user's home directory.
//
// To add or update an agent, port the change from upstream:
//   https://github.com/vercel-labs/skills/blob/main/src/agents.ts
//
// Differences from upstream:
//  * Async path resolution via PathResolverDeps (so the renderer can mock it
//    in tests). Upstream uses Node's homedir() at import time.
//  * `hermes` is a custom addition not present upstream.
//  * `universal` (an upstream sentinel with detectInstalled = false) is
//    omitted; it has no use in a UI-driven app.
//  * Env-var overrides (CLAUDE_CONFIG_DIR, CODEX_HOME, VIBE_HOME,
//    XDG_CONFIG_HOME) are not honored — the renderer cannot read shell env.

import type { PathResolverDeps } from "../paths";

export interface AgentConfig {
  name: string;
  displayName: string;
  /** Project-relative directory, joined with the project root. */
  skillsDir: string;
  /** Absolute directory for `-g` / global scope. */
  globalSkillsDir: (deps: PathResolverDeps) => Promise<string>;
  /**
   * Hidden from the universal `.agents/skills` listing in upstream. Used here
   * to drop sentinel-like entries from the UI tool picker.
   */
  showInUniversalList?: boolean;
}

// Helpers — kept terse so the registry below mirrors upstream line-for-line.
const home = (deps: PathResolverDeps, ...parts: string[]) =>
  deps.homeDir().then((h) => deps.join(h, ...parts));
const configHome = (deps: PathResolverDeps, ...parts: string[]) =>
  // XDG_BASE_DIR fallback. We can't read XDG_CONFIG_HOME from the renderer,
  // so always use ~/.config — matches upstream's fallback when xdgConfig is
  // null (Linux default; macOS via the xdg-basedir polyfill).
  deps.homeDir().then((h) => deps.join(h, ".config", ...parts));

export const agents: Record<string, AgentConfig> = {
  "aider-desk": {
    name: "aider-desk",
    displayName: "AiderDesk",
    skillsDir: ".aider-desk/skills",
    globalSkillsDir: (d) => home(d, ".aider-desk", "skills"),
  },
  amp: {
    name: "amp",
    displayName: "Amp",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => configHome(d, "agents", "skills"),
  },
  antigravity: {
    name: "antigravity",
    displayName: "Antigravity",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".gemini", "antigravity", "skills"),
  },
  augment: {
    name: "augment",
    displayName: "Augment",
    skillsDir: ".augment/skills",
    globalSkillsDir: (d) => home(d, ".augment", "skills"),
  },
  bob: {
    name: "bob",
    displayName: "IBM Bob",
    skillsDir: ".bob/skills",
    globalSkillsDir: (d) => home(d, ".bob", "skills"),
  },
  // Aliased to upstream's `claude-code`. The desktop app has used `claude` as
  // the key since before the registry existed; renaming the key would break
  // saved settings in localStorage and existing backups.
  claude: {
    name: "claude",
    displayName: "Claude Code",
    skillsDir: ".claude/skills",
    globalSkillsDir: (d) => home(d, ".claude", "skills"),
  },
  cline: {
    name: "cline",
    displayName: "Cline",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".agents", "skills"),
  },
  "codearts-agent": {
    name: "codearts-agent",
    displayName: "CodeArts Agent",
    skillsDir: ".codeartsdoer/skills",
    globalSkillsDir: (d) => home(d, ".codeartsdoer", "skills"),
  },
  codebuddy: {
    name: "codebuddy",
    displayName: "CodeBuddy",
    skillsDir: ".codebuddy/skills",
    globalSkillsDir: (d) => home(d, ".codebuddy", "skills"),
  },
  codemaker: {
    name: "codemaker",
    displayName: "Codemaker",
    skillsDir: ".codemaker/skills",
    globalSkillsDir: (d) => home(d, ".codemaker", "skills"),
  },
  codestudio: {
    name: "codestudio",
    displayName: "Code Studio",
    skillsDir: ".codestudio/skills",
    globalSkillsDir: (d) => home(d, ".codestudio", "skills"),
  },
  codex: {
    name: "codex",
    displayName: "Codex",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".codex", "skills"),
  },
  "command-code": {
    name: "command-code",
    displayName: "Command Code",
    skillsDir: ".commandcode/skills",
    globalSkillsDir: (d) => home(d, ".commandcode", "skills"),
  },
  continue: {
    name: "continue",
    displayName: "Continue",
    skillsDir: ".continue/skills",
    globalSkillsDir: (d) => home(d, ".continue", "skills"),
  },
  cortex: {
    name: "cortex",
    displayName: "Cortex Code",
    skillsDir: ".cortex/skills",
    globalSkillsDir: (d) => home(d, ".snowflake", "cortex", "skills"),
  },
  crush: {
    name: "crush",
    displayName: "Crush",
    skillsDir: ".crush/skills",
    globalSkillsDir: (d) => home(d, ".config", "crush", "skills"),
  },
  cursor: {
    name: "cursor",
    displayName: "Cursor",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".cursor", "skills"),
  },
  deepagents: {
    name: "deepagents",
    displayName: "Deep Agents",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".deepagents", "agent", "skills"),
  },
  devin: {
    name: "devin",
    displayName: "Devin for Terminal",
    skillsDir: ".devin/skills",
    globalSkillsDir: (d) => configHome(d, "devin", "skills"),
  },
  dexto: {
    name: "dexto",
    displayName: "Dexto",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".agents", "skills"),
  },
  droid: {
    name: "droid",
    displayName: "Droid",
    skillsDir: ".factory/skills",
    globalSkillsDir: (d) => home(d, ".factory", "skills"),
  },
  firebender: {
    name: "firebender",
    displayName: "Firebender",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".firebender", "skills"),
  },
  forgecode: {
    name: "forgecode",
    displayName: "ForgeCode",
    skillsDir: ".forge/skills",
    globalSkillsDir: (d) => home(d, ".forge", "skills"),
  },
  "gemini-cli": {
    name: "gemini-cli",
    displayName: "Gemini CLI",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".gemini", "skills"),
  },
  "github-copilot": {
    name: "github-copilot",
    displayName: "GitHub Copilot",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".copilot", "skills"),
  },
  goose: {
    name: "goose",
    displayName: "Goose",
    skillsDir: ".goose/skills",
    globalSkillsDir: (d) => configHome(d, "goose", "skills"),
  },
  // Custom — not in upstream. Hermes (https://hermes-agent.nousresearch.com)
  // ships agentskills.io-style SKILL.md bundles under ~/.hermes/skills/ and
  // supports an optional category-nesting layout that the lister handles.
  hermes: {
    name: "hermes",
    displayName: "Hermes",
    skillsDir: ".hermes/skills",
    globalSkillsDir: (d) => home(d, ".hermes", "skills"),
  },
  "iflow-cli": {
    name: "iflow-cli",
    displayName: "iFlow CLI",
    skillsDir: ".iflow/skills",
    globalSkillsDir: (d) => home(d, ".iflow", "skills"),
  },
  junie: {
    name: "junie",
    displayName: "Junie",
    skillsDir: ".junie/skills",
    globalSkillsDir: (d) => home(d, ".junie", "skills"),
  },
  kilo: {
    name: "kilo",
    displayName: "Kilo Code",
    skillsDir: ".kilocode/skills",
    globalSkillsDir: (d) => home(d, ".kilocode", "skills"),
  },
  "kimi-cli": {
    name: "kimi-cli",
    displayName: "Kimi Code CLI",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".config", "agents", "skills"),
  },
  "kiro-cli": {
    name: "kiro-cli",
    displayName: "Kiro CLI",
    skillsDir: ".kiro/skills",
    globalSkillsDir: (d) => home(d, ".kiro", "skills"),
  },
  kode: {
    name: "kode",
    displayName: "Kode",
    skillsDir: ".kode/skills",
    globalSkillsDir: (d) => home(d, ".kode", "skills"),
  },
  mcpjam: {
    name: "mcpjam",
    displayName: "MCPJam",
    skillsDir: ".mcpjam/skills",
    globalSkillsDir: (d) => home(d, ".mcpjam", "skills"),
  },
  "mistral-vibe": {
    name: "mistral-vibe",
    displayName: "Mistral Vibe",
    skillsDir: ".vibe/skills",
    globalSkillsDir: (d) => home(d, ".vibe", "skills"),
  },
  mux: {
    name: "mux",
    displayName: "Mux",
    skillsDir: ".mux/skills",
    globalSkillsDir: (d) => home(d, ".mux", "skills"),
  },
  neovate: {
    name: "neovate",
    displayName: "Neovate",
    skillsDir: ".neovate/skills",
    globalSkillsDir: (d) => home(d, ".neovate", "skills"),
  },
  openclaw: {
    name: "openclaw",
    displayName: "OpenClaw",
    // Upstream uses bare `skills` for project scope. Mirrored here so a
    // project containing both ./skills/ and ./.agents/skills/ matches what
    // `npx skills add openclaw …` writes.
    skillsDir: "skills",
    globalSkillsDir: (d) => home(d, ".openclaw", "skills"),
  },
  opencode: {
    name: "opencode",
    displayName: "OpenCode",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => configHome(d, "opencode", "skills"),
  },
  openhands: {
    name: "openhands",
    displayName: "OpenHands",
    skillsDir: ".openhands/skills",
    globalSkillsDir: (d) => home(d, ".openhands", "skills"),
  },
  pi: {
    name: "pi",
    displayName: "Pi",
    skillsDir: ".pi/skills",
    globalSkillsDir: (d) => home(d, ".pi", "agent", "skills"),
  },
  pochi: {
    name: "pochi",
    displayName: "Pochi",
    skillsDir: ".pochi/skills",
    globalSkillsDir: (d) => home(d, ".pochi", "skills"),
  },
  qoder: {
    name: "qoder",
    displayName: "Qoder",
    skillsDir: ".qoder/skills",
    globalSkillsDir: (d) => home(d, ".qoder", "skills"),
  },
  "qwen-code": {
    name: "qwen-code",
    displayName: "Qwen Code",
    skillsDir: ".qwen/skills",
    globalSkillsDir: (d) => home(d, ".qwen", "skills"),
  },
  replit: {
    name: "replit",
    displayName: "Replit",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => configHome(d, "agents", "skills"),
    showInUniversalList: false,
  },
  rovodev: {
    name: "rovodev",
    displayName: "Rovo Dev",
    skillsDir: ".rovodev/skills",
    globalSkillsDir: (d) => home(d, ".rovodev", "skills"),
  },
  roo: {
    name: "roo",
    displayName: "Roo Code",
    skillsDir: ".roo/skills",
    globalSkillsDir: (d) => home(d, ".roo", "skills"),
  },
  "tabnine-cli": {
    name: "tabnine-cli",
    displayName: "Tabnine CLI",
    skillsDir: ".tabnine/agent/skills",
    globalSkillsDir: (d) => home(d, ".tabnine", "agent", "skills"),
  },
  trae: {
    name: "trae",
    displayName: "Trae",
    skillsDir: ".trae/skills",
    globalSkillsDir: (d) => home(d, ".trae", "skills"),
  },
  "trae-cn": {
    name: "trae-cn",
    displayName: "Trae CN",
    skillsDir: ".trae/skills",
    globalSkillsDir: (d) => home(d, ".trae-cn", "skills"),
  },
  warp: {
    name: "warp",
    displayName: "Warp",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".agents", "skills"),
  },
  windsurf: {
    name: "windsurf",
    displayName: "Windsurf",
    skillsDir: ".windsurf/skills",
    globalSkillsDir: (d) => home(d, ".codeium", "windsurf", "skills"),
  },
  zencoder: {
    name: "zencoder",
    displayName: "Zencoder",
    skillsDir: ".zencoder/skills",
    globalSkillsDir: (d) => home(d, ".zencoder", "skills"),
  },
  adal: {
    name: "adal",
    displayName: "AdaL",
    skillsDir: ".adal/skills",
    globalSkillsDir: (d) => home(d, ".adal", "skills"),
  },
};

export type AgentName = keyof typeof agents;

export const ALL_AGENTS: AgentName[] = Object.keys(agents).sort() as AgentName[];

export function getAgentConfig(name: string): AgentConfig | undefined {
  return agents[name];
}

export function isKnownAgent(name: string): name is AgentName {
  return Object.prototype.hasOwnProperty.call(agents, name);
}

export function displayNameOf(name: string): string {
  return agents[name]?.displayName ?? name;
}

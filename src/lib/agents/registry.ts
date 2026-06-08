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
//  * `extraSkillsDirs` / `extraGlobalSkillsDirs` capture each agent's *extra*
//    read-only scan locations (the cross-tool `.agents/skills` convention,
//    XDG `~/.config/agents/skills`, legacy `.claude/skills` compat, etc.)
//    documented in each tool's own docs. Upstream uses a binary
//    `isUniversal` flag and a single path per agent; the SkillSafe app
//    needs the full discovery surface so the listing matches what each
//    agent actually sees on disk. Writes (install, save, backup) still go
//    through the primary `skillsDir` / `globalSkillsDir` — extras are
//    listing-only.

import type { PathResolverDeps } from "../paths";

export interface AgentConfig {
  name: string;
  displayName: string;
  /** Project-relative directory, joined with the project root. The canonical
   *  install target — writes (install, save, backup) always go here. */
  skillsDir: string;
  /** Absolute directory for `-g` / global scope. The canonical global install
   *  target. */
  globalSkillsDir: (deps: PathResolverDeps) => Promise<string>;
  /** Additional project-relative directories the agent reads at project
   *  scope. Listing-only — installs/writes still target `skillsDir`. Each
   *  entry is documented in the agent's official docs (see the per-agent
   *  comments in the registry below). */
  extraSkillsDirs?: string[];
  /** Additional global directories the agent reads at user scope.
   *  Listing-only — installs/writes still target `globalSkillsDir`. */
  extraGlobalSkillsDirs?: ((deps: PathResolverDeps) => Promise<string>)[];
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

// Cross-tool universal scan locations. Several agents read these in addition
// to their tool-specific path; centralising the resolvers keeps the registry
// entries below readable.
const universalGlobalSkillsDir = (d: PathResolverDeps) => home(d, ".agents", "skills");
const xdgUniversalGlobalSkillsDir = (d: PathResolverDeps) => configHome(d, "agents", "skills");
const UNIVERSAL_PROJECT_SKILLS_DIR = ".agents/skills";

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
  // https://antigravity.google/docs/skills + Gemini CLI compat
  antigravity: {
    name: "antigravity",
    displayName: "Antigravity",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".gemini", "antigravity", "skills"),
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://docs.augmentcode.com/cli/skills — six locations scanned total
  augment: {
    name: "augment",
    displayName: "Augment",
    skillsDir: ".augment/skills",
    globalSkillsDir: (d) => home(d, ".augment", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
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
  //
  // Claude Code itself only scans `.claude/skills` and `~/.claude/skills` per
  // Anthropic's docs. The `.agents/skills` project extra is a SkillSafe-side
  // convenience so skills installed via `npx skills add` (which writes to the
  // cross-tool `.agents/skills/`) surface in the Claude view too. No global
  // extra — `~/.agents/skills` is not part of the Claude listing in this app.
  claude: {
    name: "claude",
    displayName: "Claude Code",
    skillsDir: ".claude/skills",
    globalSkillsDir: (d) => home(d, ".claude", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
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
  // https://developers.openai.com/codex/skills — global scans both
  // `~/.codex/skills` and `$HOME/.agents/skills`.
  codex: {
    name: "codex",
    displayName: "Codex",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".codex", "skills"),
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://commandcode.ai/docs/skills — universal `.agents/skills` discovered
  // at both scopes; `.commandcode/skills/` wins on name conflicts.
  "command-code": {
    name: "command-code",
    displayName: "Command Code",
    skillsDir: ".commandcode/skills",
    globalSkillsDir: (d) => home(d, ".commandcode", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
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
  // https://github.com/charmbracelet/crush — globals enumerated:
  //   $XDG_CONFIG_HOME/crush/skills (primary), $XDG_CONFIG_HOME/agents/skills,
  //   ~/.agents/skills, ~/.claude/skills. Project: .agents/skills, .crush/skills,
  //   .claude/skills, .cursor/skills. We honor the `.agents` ones.
  crush: {
    name: "crush",
    displayName: "Crush",
    skillsDir: ".crush/skills",
    globalSkillsDir: (d) => home(d, ".config", "crush", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir, xdgUniversalGlobalSkillsDir],
  },
  // https://cursor.com/docs/skills
  cursor: {
    name: "cursor",
    displayName: "Cursor",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".cursor", "skills"),
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  deepagents: {
    name: "deepagents",
    displayName: "Deep Agents",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".deepagents", "agent", "skills"),
  },
  // https://docs.devin.ai/cli/extensibility/skills/overview — six locations
  // total (`.agents/skills`, `.devin/skills`, `.windsurf/skills` x both scopes).
  devin: {
    name: "devin",
    displayName: "Devin for Terminal",
    skillsDir: ".devin/skills",
    globalSkillsDir: (d) => configHome(d, "devin", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
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
  // https://docs.firebender.com/multi-agent/skills — `~/.agents/skills` is in
  // the documented cross-agent compat list at user scope.
  firebender: {
    name: "firebender",
    displayName: "Firebender",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".firebender", "skills"),
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://forgecode.dev/docs/skills/ — `~/.agents/skills` is a first-class
  // "agents" tier between project and global.
  forgecode: {
    name: "forgecode",
    displayName: "ForgeCode",
    skillsDir: ".forge/skills",
    globalSkillsDir: (d) => home(d, ".forge", "skills"),
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://geminicli.com/docs/cli/skills/ — `~/.agents/skills` is the
  // documented alias of `~/.gemini/skills`; same for `.agents/skills`.
  "gemini-cli": {
    name: "gemini-cli",
    displayName: "Gemini CLI",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".gemini", "skills"),
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
  "github-copilot": {
    name: "github-copilot",
    displayName: "GitHub Copilot",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".copilot", "skills"),
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://goose-docs.ai/docs/guides/context-engineering/using-skills/
  // Project: `.agents/skills` recommended, plus `.goose/skills` legacy.
  // Global: `~/.config/agents/skills` recommended, plus `~/.agents/skills`.
  goose: {
    name: "goose",
    displayName: "Goose",
    skillsDir: ".goose/skills",
    globalSkillsDir: (d) => configHome(d, "goose", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir, xdgUniversalGlobalSkillsDir],
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
  // https://kilo.ai/docs/customize/skills — project-side compat lists
  // `.claude/skills/` and `.agents/skills/`. Global compat path is not
  // explicitly documented.
  kilo: {
    name: "kilo",
    displayName: "Kilo Code",
    skillsDir: ".kilocode/skills",
    globalSkillsDir: (d) => home(d, ".kilocode", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
  },
  // https://moonshotai.github.io/kimi-cli/en/customization/skills.html
  // Generic globals: `~/.config/agents/skills` (recommended) AND
  // `~/.agents/skills`.
  "kimi-cli": {
    name: "kimi-cli",
    displayName: "Kimi Code CLI",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".config", "agents", "skills"),
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
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
  // https://docs.mcpjam.com/inspector/skills — explicit table of scanned dirs.
  mcpjam: {
    name: "mcpjam",
    displayName: "MCPJam",
    skillsDir: ".mcpjam/skills",
    globalSkillsDir: (d) => home(d, ".mcpjam", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://docs.mistral.ai/vibe/code/cli/skills — `./.agents/skills/`
  // accepted at project scope (when the working directory is trusted). User
  // scope: only `~/.vibe/skills/`.
  "mistral-vibe": {
    name: "mistral-vibe",
    displayName: "Mistral Vibe",
    skillsDir: ".vibe/skills",
    globalSkillsDir: (d) => home(d, ".vibe", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
  },
  // https://mux.coder.com/agents/agent-skills — precedence ladder explicitly
  // includes `.agents/skills` and `~/.agents/skills`.
  mux: {
    name: "mux",
    displayName: "Mux",
    skillsDir: ".mux/skills",
    globalSkillsDir: (d) => home(d, ".mux", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  neovate: {
    name: "neovate",
    displayName: "Neovate",
    skillsDir: ".neovate/skills",
    globalSkillsDir: (d) => home(d, ".neovate", "skills"),
  },
  // https://docs.openclaw.ai/tools/skills-config — loading order includes
  // `workspace/.agents/skills` and `~/.agents/skills`.
  openclaw: {
    name: "openclaw",
    displayName: "OpenClaw",
    // Upstream uses bare `skills` for project scope. Mirrored here so a
    // project containing both ./skills/ and ./.agents/skills/ matches what
    // `npx skills add openclaw …` writes.
    skillsDir: "skills",
    globalSkillsDir: (d) => home(d, ".openclaw", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://opencode.ai/docs/skills/ — global also reads `~/.agents/skills`;
  // project walks up looking for `.agents/skills/*/SKILL.md`.
  opencode: {
    name: "opencode",
    displayName: "OpenCode",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => configHome(d, "opencode", "skills"),
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://docs.openhands.dev/overview/skills — `.agents/skills` is the
  // recommended primary; `.openhands/skills` is deprecated but still read.
  // We keep `.openhands/skills` as primary to avoid changing install
  // behaviour for existing users, and scan `.agents/skills` as an extra so
  // skills installed via the universal path still surface.
  openhands: {
    name: "openhands",
    displayName: "OpenHands",
    skillsDir: ".openhands/skills",
    globalSkillsDir: (d) => home(d, ".openhands", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://pi.dev/docs/latest/skills — global reads both `~/.pi/agent/skills`
  // and `~/.agents/skills`; project walks up from cwd to repo root reading
  // both `.pi/skills` and `.agents/skills`.
  pi: {
    name: "pi",
    displayName: "Pi",
    skillsDir: ".pi/skills",
    globalSkillsDir: (d) => home(d, ".pi", "agent", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://docs.getpochi.com/ — explicit priority ladder lists both
  // `.agents/skills` and `~/.agents/skills` as cross-agent standards.
  pochi: {
    name: "pochi",
    displayName: "Pochi",
    skillsDir: ".pochi/skills",
    globalSkillsDir: (d) => home(d, ".pochi", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
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
  // https://support.atlassian.com/rovo/docs/extend-rovo-dev-cli-with-agent-skills/
  // Both `.rovodev/skills` and `.agents/skills` accepted at both scopes.
  rovodev: {
    name: "rovodev",
    displayName: "Rovo Dev",
    skillsDir: ".rovodev/skills",
    globalSkillsDir: (d) => home(d, ".rovodev", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://docs.roocode.com/features/skills — workspace `.agents/skills`
  // overrides global `~/.roo/skills`. Global cross-agent path not documented.
  roo: {
    name: "roo",
    displayName: "Roo Code",
    skillsDir: ".roo/skills",
    globalSkillsDir: (d) => home(d, ".roo", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
  },
  // https://docs.tabnine.com/main/getting-started/tabnine-cli/features/agent-skills
  "tabnine-cli": {
    name: "tabnine-cli",
    displayName: "Tabnine CLI",
    skillsDir: ".tabnine/agent/skills",
    globalSkillsDir: (d) => home(d, ".tabnine", "agent", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://docs.trae.ai/ide/skills — `.agents/skills` documented as a
  // convention-based directory the agent auto-discovers; `.trae/skills` wins
  // on name conflict. Global path not documented.
  trae: {
    name: "trae",
    displayName: "Trae",
    skillsDir: ".trae/skills",
    globalSkillsDir: (d) => home(d, ".trae", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
  },
  "trae-cn": {
    name: "trae-cn",
    displayName: "Trae CN",
    skillsDir: ".trae/skills",
    globalSkillsDir: (d) => home(d, ".trae-cn", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
  },
  warp: {
    name: "warp",
    displayName: "Warp",
    skillsDir: ".agents/skills",
    globalSkillsDir: (d) => home(d, ".agents", "skills"),
  },
  // https://docs.devin.ai/desktop/cascade/skills (Windsurf docs)
  windsurf: {
    name: "windsurf",
    displayName: "Windsurf",
    skillsDir: ".windsurf/skills",
    globalSkillsDir: (d) => home(d, ".codeium", "windsurf", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
    extraGlobalSkillsDirs: [universalGlobalSkillsDir],
  },
  // https://docs.zencoder.ai/features/skills — `.agents/skills` is the
  // current recommended project path; `.zencoder/skills` is legacy. Global
  // cross-agent path not explicitly documented.
  zencoder: {
    name: "zencoder",
    displayName: "Zencoder",
    skillsDir: ".zencoder/skills",
    globalSkillsDir: (d) => home(d, ".zencoder", "skills"),
    extraSkillsDirs: [UNIVERSAL_PROJECT_SKILLS_DIR],
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

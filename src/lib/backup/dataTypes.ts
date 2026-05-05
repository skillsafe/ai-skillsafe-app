// Per-tool data-type registry — the user can choose which slices of a tool's
// config to include in the backup. The script generator reads this to render
// one rsync/robocopy section per (tool, data-type) selection.
//
// Stable contract: `id` values are persisted in localStorage and across
// machines (via the backup destination). Adding new entries is safe; renaming
// or removing existing ids will silently drop a user's preference.

import type { PathResolverDeps } from "../paths";

export interface DataType {
  id: string;
  label: string;
  description?: string;
  /**
   * Paths to copy. Interpretation depends on `kind`:
   *  - "tree":           each entry is a directory under the tool's config
   *                      root, mirrored with --delete into a same-named
   *                      destination subdir.
   *  - "files":          each entry is a file or small dir under the tool's
   *                      config root, copied without --delete.
   *  - "claude_desktop": entries are filenames under
   *                      ~/Library/Application Support/Claude/ (macOS) or
   *                      %APPDATA%/Claude/ (Windows).
   */
  paths: string[];
  defaultEnabled: boolean;
  kind: "tree" | "files" | "claude_desktop";
}

const FALLBACK_ALL: DataType = {
  id: "all",
  label: "All config files",
  paths: ["."],
  defaultEnabled: true,
  kind: "tree",
};

const CLAUDE: DataType[] = [
  { id: "skills",       label: "Skills",            paths: ["skills"],       defaultEnabled: true,  kind: "tree" },
  { id: "commands",     label: "Commands",          paths: ["commands"],     defaultEnabled: true,  kind: "tree" },
  { id: "agents",       label: "Agents",            paths: ["agents"],       defaultEnabled: true,  kind: "tree" },
  { id: "plugins",      label: "Plugins",           paths: ["plugins"],      defaultEnabled: true,  kind: "tree" },
  {
    id: "memory",
    label: "Memory & projects",
    description: "Auto-memory and per-project conversation history under ~/.claude/projects/",
    paths: ["projects"],
    defaultEnabled: true,
    kind: "tree",
  },
  {
    id: "settings",
    label: "Settings & global instructions",
    paths: ["settings.json", ".mcp.json", "CLAUDE.md", "statusline-command.sh"],
    defaultEnabled: true,
    kind: "files",
  },
  { id: "tasks-plans", label: "Tasks & plans", paths: ["tasks", "plans"],          defaultEnabled: false, kind: "tree"  },
  { id: "history",     label: "History",      paths: ["history.jsonl", "file-history"], defaultEnabled: false, kind: "files" },
  {
    id: "desktop-config",
    label: "Claude Desktop config",
    description: "claude_desktop_config.json + config.json (MCP servers for the desktop app)",
    paths: ["claude_desktop_config.json", "config.json"],
    defaultEnabled: true,
    kind: "claude_desktop",
  },
];

const CODEX: DataType[] = [
  { id: "prompts",   label: "Prompts",   paths: ["prompts"],                  defaultEnabled: true, kind: "tree"  },
  { id: "skills",    label: "Skills",    paths: ["skills"],                   defaultEnabled: true, kind: "tree"  },
  { id: "agents-md", label: "AGENTS.md", paths: ["AGENTS.md"],                defaultEnabled: true, kind: "files" },
  { id: "config",    label: "Config",    paths: ["config.toml", "auth.json"], defaultEnabled: true, kind: "files" },
];

const SKILLS_ONLY: DataType[] = [
  { id: "skills", label: "Skills", paths: ["skills"], defaultEnabled: true, kind: "tree" },
];

const TOOL_DATA_TYPES: Record<string, DataType[]> = {
  claude: CLAUDE,
  codex: CODEX,
  cursor: SKILLS_ONLY,
  cline: SKILLS_ONLY,
  openclaw: SKILLS_ONLY,
  hermes: SKILLS_ONLY,
};

// Sources that aren't tied to a specific tool — typically shared folders
// that several agents symlink into (e.g. ~/.agents/skills, the
// vercel-labs/skills universal location). Tracked in the same `backupTools`
// localStorage list as real tool keys; resolveSections + the UI treat both
// uniformly.
export interface ExtraSource {
  id: string;
  displayName: string;
  configRoot: (deps: PathResolverDeps) => Promise<string>;
  types: DataType[];
  /** Included on first launch for users who don't have a saved preference. */
  defaultEnabled: boolean;
}

const home = (deps: PathResolverDeps, ...parts: string[]) =>
  deps.homeDir().then((h) => deps.join(h, ...parts));

export const EXTRA_SOURCES: Record<string, ExtraSource> = {
  "shared-agents": {
    id: "shared-agents",
    displayName: "Shared agents folder (~/.agents/)",
    configRoot: (d) => home(d, ".agents"),
    types: [
      {
        id: "all",
        label: "All files in ~/.agents/",
        description:
          "Universal skills folder used by Cline, Dexto, Warp, and other tools that symlink into it.",
        paths: ["."],
        defaultEnabled: true,
        kind: "tree",
      },
    ],
    defaultEnabled: true,
  },
};

export function isExtraSource(name: string): boolean {
  return name in EXTRA_SOURCES;
}

export function extraSourceFor(name: string): ExtraSource | undefined {
  return EXTRA_SOURCES[name];
}

/** Ids of extra sources marked default-enabled — seeded into the user's
 *  selection on first launch and merged in once when defaults change. */
export function defaultEnabledExtraSourceIds(): string[] {
  return Object.values(EXTRA_SOURCES)
    .filter((s) => s.defaultEnabled)
    .map((s) => s.id);
}

/** Returns the data-type list for a tool or extra source, or a single "all"
 *  fallback. */
export function dataTypesFor(tool: string): DataType[] {
  if (tool in EXTRA_SOURCES) return EXTRA_SOURCES[tool].types;
  return TOOL_DATA_TYPES[tool] ?? [FALLBACK_ALL];
}

// Set of every slot id that any tool's data-type registry declares. Used by
// the slot resolver to decide whether a relPath segment is a real data-type
// directory or just a stray top-level file in a flat-layout tool.
const KNOWN_SLOT_IDS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const types of Object.values(TOOL_DATA_TYPES)) {
    for (const t of types) s.add(t.id);
  }
  for (const src of Object.values(EXTRA_SOURCES)) {
    for (const t of src.types) s.add(t.id);
  }
  return s;
})();

/** Resolves the slot id for a manifest entry from its relPath. The first
 *  segment is the tool; the second is the slot when it matches a known
 *  data-type id, and "settings" otherwise — so loose top-level config
 *  files (e.g. `~/.agents/.skill-lock.json`) get bucketed under Settings
 *  rather than appearing as their own one-off slot. */
export function slotForPath(relPath: string): string | null {
  const parts = relPath.split("/");
  if (parts.length < 2 || !parts[1]) return null;
  if (KNOWN_SLOT_IDS.has(parts[1])) return parts[1];
  return "settings";
}

/** Default-enabled ids for a tool, used when first enabling a tool. */
export function defaultDataTypeIdsFor(tool: string): string[] {
  return dataTypesFor(tool)
    .filter((d) => d.defaultEnabled)
    .map((d) => d.id);
}

/** Resolves a user's saved selection against the current registry. Drops
 *  unknown ids (e.g. removed from the registry) and de-duplicates. */
export function normalizeDataTypeIds(tool: string, ids: readonly string[]): string[] {
  const valid = new Set(dataTypesFor(tool).map((d) => d.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export const __testing = {
  TOOL_DATA_TYPES,
  FALLBACK_ALL,
};

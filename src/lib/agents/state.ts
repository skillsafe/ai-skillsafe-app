// Per-agent state surfaces for the Workbench inventory.
//
// Sidecar to registry.ts so the upstream-mirror discipline of registry.ts
// (vercel-labs/skills) stays clean. registry.ts knows where each tool keeps
// its skill bundles; this file knows where each tool keeps its memory file,
// MCP server list, hooks, permissions, and keybindings — the surfaces
// Workbench surfaces and the Transfer flow translates between.
//
// PR 1 covers `memory` and `mcp` for claude, codex, cursor, cline. Adding a
// new tool or a new category is a matter of appending an entry below.
//
// Each surface is intentionally a tiny adapter: `paths()` lists candidate
// absolute paths to scan, `read()` parses one and returns 0..N inventory
// items. `write()` is left out of v1 — Workbench is read-only here.

import type { FsAdapter } from "../fs";
import { safeExists, safeReadDir, sha256Hex } from "../fs";
import type { PathResolverDeps } from "../paths";
import { getHome } from "../paths";
import { loadMcp } from "../configs/mcp";
import { parseCodexMcp } from "../configs/codexConfig";
import { loadSettings } from "../configs/settingsJson";
import { loadKeybindings } from "../configs/keybindings";
import type { InventoryItem, StateCategory, WorkbenchScope } from "../inventory/types";

export interface SurfaceContext {
  fs: FsAdapter;
  paths: PathResolverDeps;
  scope: WorkbenchScope;
  /** Absolute project root. Required for project scope, ignored for global. */
  projectRoot?: string;
}

export interface StateSurface {
  category: StateCategory;
  scope: WorkbenchScope;
  /**
   * Returns absolute path candidates to read. Missing files are fine —
   * `read` checks existence. Returning [] silently skips this surface
   * (e.g. cursor has no global memory).
   */
  paths: (ctx: SurfaceContext) => Promise<string[]>;
  read: (ctx: SurfaceContext, path: string) => Promise<InventoryItem[]>;
}

// ---------- helpers ----------

async function makeId(parts: string[]): Promise<string> {
  // Short hash so InventoryItem ids are stable across scans. Full SHA-256
  // is overkill but keeps a single helper for both id + contentHash.
  const h = await sha256Hex(parts.join("|"));
  return h.slice(0, 24);
}

async function statMtime(fs: FsAdapter, path: string): Promise<number> {
  try {
    return (await fs.stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// Reads a single memory markdown file (CLAUDE.md, AGENTS.md, .clinerules,
// or a single .mdc) and emits one inventory item, or [] if absent.
async function readMemoryFile(
  ctx: SurfaceContext,
  tool: string,
  path: string,
  displayName?: string,
): Promise<InventoryItem[]> {
  if (!(await safeExists(ctx.fs, path))) return [];
  let body = "";
  try {
    body = await ctx.fs.readTextFile(path);
  } catch {
    return [];
  }
  const name = displayName ?? basename(path);
  const projectPath = ctx.scope === "project" ? ctx.projectRoot ?? null : null;
  const id = await makeId(["memory", tool, ctx.scope, projectPath ?? "", name]);
  const contentHash = await sha256Hex(body);
  return [
    {
      id,
      tool,
      category: "memory",
      scope: ctx.scope,
      projectPath,
      name,
      absPath: path,
      payload: { body },
      contentHash,
      lastSeen: await statMtime(ctx.fs, path),
    },
  ];
}

// Reads an MCP file (Claude's .mcp.json shape, also used by Cursor) and
// explodes its `mcpServers` object into one item per registered server.
async function readMcpJsonFile(
  ctx: SurfaceContext,
  tool: string,
  path: string,
): Promise<InventoryItem[]> {
  if (!(await safeExists(ctx.fs, path))) return [];
  const doc = await loadMcp(ctx.fs, path);
  if (!doc.exists || doc.servers.length === 0) return [];
  const projectPath = ctx.scope === "project" ? ctx.projectRoot ?? null : null;
  const lastSeen = doc.mtimeMs ?? (await statMtime(ctx.fs, path));
  const out: InventoryItem[] = [];
  for (const { name, server } of doc.servers) {
    const payload = server as unknown;
    const id = await makeId(["mcp", tool, ctx.scope, projectPath ?? "", name]);
    const contentHash = await sha256Hex(JSON.stringify(payload));
    out.push({
      id,
      tool,
      category: "mcp",
      scope: ctx.scope,
      projectPath,
      name,
      absPath: path,
      payload,
      contentHash,
      lastSeen,
    });
  }
  return out;
}

// ---------- claude ----------

const claudeMemory: StateSurface[] = [
  {
    category: "memory",
    scope: "global",
    paths: async (ctx) => {
      const home = await getHome(ctx.paths);
      return [await ctx.paths.join(home, ".claude", "CLAUDE.md")];
    },
    read: (ctx, p) => readMemoryFile(ctx, "claude", p, "CLAUDE.md"),
  },
  {
    category: "memory",
    scope: "project",
    paths: async (ctx) => {
      if (!ctx.projectRoot) return [];
      return [await ctx.paths.join(ctx.projectRoot, "CLAUDE.md")];
    },
    read: (ctx, p) => readMemoryFile(ctx, "claude", p, "CLAUDE.md"),
  },
];

const claudeMcp: StateSurface[] = [
  {
    category: "mcp",
    scope: "global",
    paths: async (ctx) => {
      const home = await getHome(ctx.paths);
      return [await ctx.paths.join(home, ".claude", ".mcp.json")];
    },
    read: (ctx, p) => readMcpJsonFile(ctx, "claude", p),
  },
  {
    category: "mcp",
    scope: "project",
    paths: async (ctx) => {
      if (!ctx.projectRoot) return [];
      return [await ctx.paths.join(ctx.projectRoot, ".mcp.json")];
    },
    read: (ctx, p) => readMcpJsonFile(ctx, "claude", p),
  },
];

// ---------- claude hooks / permissions / keybindings ----------
//
// Claude stores hooks + permissions (and other config) in a single
// settings.json file per scope. Keybindings live in a sibling
// keybindings.json (global only). For the Workbench we surface each
// block as a single coarse "memory-like" item so users can Add to
// Master + Restore the entire block as a unit.

async function readClaudeSettingsBlock(
  ctx: SurfaceContext,
  path: string,
  block: "hooks" | "permissions",
): Promise<InventoryItem[]> {
  if (!(await safeExists(ctx.fs, path))) return [];
  const doc = await loadSettings(ctx.fs, path);
  if (!doc.exists) return [];
  const value = block === "hooks" ? doc.hooks : doc.permissions;
  if (!value || Object.keys(value).length === 0) return [];
  const projectPath = ctx.scope === "project" ? ctx.projectRoot ?? null : null;
  const id = await makeId([block, "claude", ctx.scope, projectPath ?? "", block]);
  const contentHash = await sha256Hex(JSON.stringify(value));
  let lastSeen = doc.mtimeMs ?? 0;
  if (!lastSeen) {
    try {
      lastSeen = (await ctx.fs.stat(path)).mtimeMs;
    } catch {
      /* ignore */
    }
  }
  return [
    {
      id,
      tool: "claude",
      category: block,
      scope: ctx.scope,
      projectPath,
      name: block === "hooks" ? "hooks" : "permissions",
      absPath: path,
      payload: value,
      contentHash,
      lastSeen,
    },
  ];
}

const claudeHooks: StateSurface[] = [
  {
    category: "hooks",
    scope: "global",
    paths: async (ctx) => {
      const home = await getHome(ctx.paths);
      return [await ctx.paths.join(home, ".claude", "settings.json")];
    },
    read: (ctx, p) => readClaudeSettingsBlock(ctx, p, "hooks"),
  },
  {
    category: "hooks",
    scope: "project",
    paths: async (ctx) => {
      if (!ctx.projectRoot) return [];
      return [await ctx.paths.join(ctx.projectRoot, ".claude", "settings.json")];
    },
    read: (ctx, p) => readClaudeSettingsBlock(ctx, p, "hooks"),
  },
];

const claudePermissions: StateSurface[] = [
  {
    category: "permissions",
    scope: "global",
    paths: async (ctx) => {
      const home = await getHome(ctx.paths);
      return [await ctx.paths.join(home, ".claude", "settings.json")];
    },
    read: (ctx, p) => readClaudeSettingsBlock(ctx, p, "permissions"),
  },
  {
    category: "permissions",
    scope: "project",
    paths: async (ctx) => {
      if (!ctx.projectRoot) return [];
      return [await ctx.paths.join(ctx.projectRoot, ".claude", "settings.json")];
    },
    read: (ctx, p) => readClaudeSettingsBlock(ctx, p, "permissions"),
  },
];

async function readClaudeKeybindings(
  ctx: SurfaceContext,
  path: string,
): Promise<InventoryItem[]> {
  if (!(await safeExists(ctx.fs, path))) return [];
  const doc = await loadKeybindings(ctx.fs, path);
  if (!doc.exists) return [];
  // Keep the full doc shape (bindings + rest) so a round-trip restore
  // doesn't drop unknown top-level keys.
  const payload: Record<string, unknown> = { ...doc.rest, bindings: doc.bindings };
  if (doc.bindings.length === 0 && Object.keys(doc.rest).length === 0) return [];
  const id = await makeId(["keybindings", "claude", "global", "", "keybindings"]);
  const contentHash = await sha256Hex(JSON.stringify(payload));
  let lastSeen = doc.mtimeMs ?? 0;
  if (!lastSeen) {
    try {
      lastSeen = (await ctx.fs.stat(path)).mtimeMs;
    } catch {
      /* ignore */
    }
  }
  return [
    {
      id,
      tool: "claude",
      category: "keybindings",
      scope: "global",
      projectPath: null,
      name: "keybindings",
      absPath: path,
      payload,
      contentHash,
      lastSeen,
    },
  ];
}

const claudeKeybindings: StateSurface[] = [
  {
    category: "keybindings",
    scope: "global",
    paths: async (ctx) => {
      const home = await getHome(ctx.paths);
      return [await ctx.paths.join(home, ".claude", "keybindings.json")];
    },
    read: (ctx, p) => readClaudeKeybindings(ctx, p),
  },
];

// ---------- codex ----------

const codexMemory: StateSurface[] = [
  {
    category: "memory",
    scope: "global",
    paths: async (ctx) => {
      const home = await getHome(ctx.paths);
      return [await ctx.paths.join(home, ".codex", "AGENTS.md")];
    },
    read: (ctx, p) => readMemoryFile(ctx, "codex", p, "AGENTS.md"),
  },
  {
    category: "memory",
    scope: "project",
    paths: async (ctx) => {
      if (!ctx.projectRoot) return [];
      return [await ctx.paths.join(ctx.projectRoot, "AGENTS.md")];
    },
    read: (ctx, p) => readMemoryFile(ctx, "codex", p, "AGENTS.md"),
  },
];

// Codex MCP lives in ~/.codex/config.toml under [mcp_servers.*]. We
// parse just those sections (everything else is preserved verbatim on
// write) via configs/codexConfig.ts.
async function readCodexMcpFile(
  ctx: SurfaceContext,
  path: string,
): Promise<InventoryItem[]> {
  if (!(await safeExists(ctx.fs, path))) return [];
  let raw = "";
  try {
    raw = await ctx.fs.readTextFile(path);
  } catch {
    return [];
  }
  const doc = parseCodexMcp(raw);
  if (doc.servers.length === 0) return [];
  const projectPath = ctx.scope === "project" ? ctx.projectRoot ?? null : null;
  let lastSeen = 0;
  try {
    lastSeen = (await ctx.fs.stat(path)).mtimeMs;
  } catch {
    /* ignore */
  }
  const out: InventoryItem[] = [];
  for (const { name, server } of doc.servers) {
    const id = await makeId(["mcp", "codex", ctx.scope, projectPath ?? "", name]);
    const contentHash = await sha256Hex(JSON.stringify(server));
    out.push({
      id,
      tool: "codex",
      category: "mcp",
      scope: ctx.scope,
      projectPath,
      name,
      absPath: path,
      payload: server,
      contentHash,
      lastSeen,
    });
  }
  return out;
}

const codexMcp: StateSurface[] = [
  {
    category: "mcp",
    scope: "global",
    paths: async (ctx) => {
      const home = await getHome(ctx.paths);
      return [await ctx.paths.join(home, ".codex", "config.toml")];
    },
    read: (ctx, p) => readCodexMcpFile(ctx, p),
  },
];

// ---------- cursor ----------
//
// Cursor's "memory" surface is a directory of .mdc files at
// <project>/.cursor/rules/. Each file is a separately-named rule, so we
// emit one inventory item per file. There's no global cursor memory.
const cursorMemory: StateSurface[] = [
  {
    category: "memory",
    scope: "project",
    paths: async (ctx) => {
      if (!ctx.projectRoot) return [];
      const dir = await ctx.paths.join(ctx.projectRoot, ".cursor", "rules");
      const entries = await safeReadDir(ctx.fs, dir);
      const out: string[] = [];
      for (const e of entries) {
        if (!e.isFile) continue;
        if (!e.name.endsWith(".mdc")) continue;
        out.push(await ctx.paths.join(dir, e.name));
      }
      return out;
    },
    read: (ctx, p) => readMemoryFile(ctx, "cursor", p),
  },
];

const cursorMcp: StateSurface[] = [
  {
    category: "mcp",
    scope: "global",
    paths: async (ctx) => {
      const home = await getHome(ctx.paths);
      return [await ctx.paths.join(home, ".cursor", "mcp.json")];
    },
    read: (ctx, p) => readMcpJsonFile(ctx, "cursor", p),
  },
  {
    category: "mcp",
    scope: "project",
    paths: async (ctx) => {
      if (!ctx.projectRoot) return [];
      return [await ctx.paths.join(ctx.projectRoot, ".cursor", "mcp.json")];
    },
    read: (ctx, p) => readMcpJsonFile(ctx, "cursor", p),
  },
];

// ---------- cline ----------
//
// Older Cline used a single <project>/.clinerules file; newer versions use
// a <project>/.clinerules/ directory of .md rule files. Handle both.
const clineMemory: StateSurface[] = [
  {
    category: "memory",
    scope: "project",
    paths: async (ctx) => {
      if (!ctx.projectRoot) return [];
      const single = await ctx.paths.join(ctx.projectRoot, ".clinerules");
      if (!(await safeExists(ctx.fs, single))) return [];
      try {
        const s = await ctx.fs.stat(single);
        if (s.isFile) return [single];
        if (s.isDirectory) {
          const entries = await safeReadDir(ctx.fs, single);
          const out: string[] = [];
          for (const e of entries) {
            if (!e.isFile) continue;
            if (!e.name.endsWith(".md")) continue;
            out.push(await ctx.paths.join(single, e.name));
          }
          return out;
        }
      } catch {
        /* ignore */
      }
      return [];
    },
    read: (ctx, p) => readMemoryFile(ctx, "cline", p),
  },
];

// ---------- map ----------

export const stateSurfaces: Record<string, StateSurface[]> = {
  claude: [
    ...claudeMemory,
    ...claudeMcp,
    ...claudeHooks,
    ...claudePermissions,
    ...claudeKeybindings,
  ],
  codex: [...codexMemory, ...codexMcp],
  cursor: [...cursorMemory, ...cursorMcp],
  cline: [...clineMemory],
};

export function surfacesFor(tool: string): StateSurface[] {
  return stateSurfaces[tool] ?? [];
}

/**
 * Tools that have any Workbench surface defined. Other registry agents
 * appear in the inventory's source list as "no surfaces yet" until a
 * follow-up PR adds one.
 */
export function toolsWithSurfaces(): string[] {
  return Object.keys(stateSurfaces);
}

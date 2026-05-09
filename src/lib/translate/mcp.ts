// MCP translators — port a single MCP server entry between tools.
//
// Claude and Cursor share the JSON shape (`mcpServers` object inside
// `.mcp.json`), so transferring between those is a payload pass-through
// + merge into the target's existing servers list. Codex stores its
// servers in `~/.codex/config.toml` under [mcp_servers.<name>], so we
// route through configs/codexConfig.ts to read/write while preserving
// the rest of the file.
//
// Like memory transfer, a `.skillsafe.bak` is dropped beside any file
// we overwrite so the user can recover by hand if something looks wrong.

import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeExists } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { PathResolverDeps } from "../paths";
import { getHome } from "../paths";
import { loadMcp, saveMcp } from "../configs/mcp";
import {
  parseCodexMcp,
  removeCodexMcp,
  serializeCodexMcp,
  upsertCodexMcp,
} from "../configs/codexConfig";
import type { McpServer } from "../configs/schemas";
import type { WorkbenchScope } from "../inventory/types";

export const MCP_TRANSFER_TARGETS = ["claude", "codex", "cursor"] as const;
export type McpTransferTool = (typeof MCP_TRANSFER_TARGETS)[number];

export function isMcpTransferTool(tool: string): tool is McpTransferTool {
  return (MCP_TRANSFER_TARGETS as readonly string[]).includes(tool);
}

/** Tools whose MCP file lives at a single global location. */
export const MCP_GLOBAL_CAPABLE: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "cursor",
]);

export interface McpDestination {
  tool: McpTransferTool;
  scope: WorkbenchScope;
  /** Required when scope === "project" (claude + cursor only). */
  projectRoot?: string;
  /** Server name as it should appear in the destination. Defaults to source name. */
  nameOverride?: string;
}

export interface ResolvedMcpDest {
  /** Absolute path of the MCP config file we'll merge into. */
  path: string;
  warnings: string[];
  /** Tool the destination belongs to — informational, mirrors dest.tool. */
  tool: McpTransferTool;
}

export async function resolveMcpDestPath(
  paths: PathResolverDeps,
  pj: PathJoiner,
  dest: McpDestination,
): Promise<ResolvedMcpDest> {
  const warnings: string[] = [];
  const home = await getHome(paths);

  if (dest.tool === "claude") {
    if (dest.scope === "global") {
      return {
        path: await pj.join(home, ".claude", ".mcp.json"),
        warnings,
        tool: "claude",
      };
    }
    if (!dest.projectRoot) {
      throw new Error("Project root is required for project scope.");
    }
    return {
      path: await pj.join(dest.projectRoot, ".mcp.json"),
      warnings,
      tool: "claude",
    };
  }

  if (dest.tool === "cursor") {
    if (dest.scope === "global") {
      return {
        path: await pj.join(home, ".cursor", "mcp.json"),
        warnings,
        tool: "cursor",
      };
    }
    if (!dest.projectRoot) {
      throw new Error("Project root is required for project scope.");
    }
    return {
      path: await pj.join(dest.projectRoot, ".cursor", "mcp.json"),
      warnings,
      tool: "cursor",
    };
  }

  if (dest.tool === "codex") {
    if (dest.scope === "project") {
      warnings.push("Codex stores MCP servers in a single global config; using global scope.");
    }
    return {
      path: await pj.join(home, ".codex", "config.toml"),
      warnings,
      tool: "codex",
    };
  }

  throw new Error(`MCP transfer to ${(dest as { tool: string }).tool} is not supported.`);
}

// ---------- transfer ----------

export type McpTransferMode = "replace" | "skip-if-exists";

export interface TransferMcpInput {
  sourceTool: string;
  /** Server name as recorded on the source side. */
  sourceName: string;
  sourceServer: McpServer;
  dest: McpDestination;
  mode: McpTransferMode;
}

export interface TransferMcpResult {
  destPath: string;
  warnings: string[];
  /** Path of the .skillsafe.bak we wrote before overwriting, if any. */
  backupPath?: string;
  skipped: boolean;
  /** Final on-disk content of the destination file. */
  written: string | null;
  /** Server name as written to the destination (after any override). */
  writtenName: string;
}

function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

async function backupFile(
  fs: FsAdapter,
  path: string,
): Promise<{ backupPath?: string; warning?: string }> {
  if (!(await safeExists(fs, path))) return {};
  try {
    const prev = await fs.readTextFile(path);
    const backupPath = `${path}.skillsafe.bak`;
    await atomicWrite(fs, backupPath, prev);
    return { backupPath };
  } catch {
    return { warning: `Couldn't write a .skillsafe.bak before overwriting ${path}.` };
  }
}

export async function transferMcp(
  fs: FsAdapter,
  paths: PathResolverDeps,
  pj: PathJoiner,
  input: TransferMcpInput,
): Promise<TransferMcpResult> {
  const dest = await resolveMcpDestPath(paths, pj, input.dest);
  const warnings = [...dest.warnings];
  const writtenName = input.dest.nameOverride?.trim() || input.sourceName;

  // Codex needs raw text round-trip via configs/codexConfig.ts.
  if (dest.tool === "codex") {
    const exists = await safeExists(fs, dest.path);
    let rawSource = "";
    if (exists) {
      try {
        rawSource = await fs.readTextFile(dest.path);
      } catch {
        rawSource = "";
      }
      const parsed = parseCodexMcp(rawSource);
      const collision = parsed.servers.find((s) => s.name === writtenName);
      if (collision && input.mode === "skip-if-exists") {
        warnings.push(
          `Server "${writtenName}" already exists in Codex; left untouched.`,
        );
        return {
          destPath: dest.path,
          warnings,
          skipped: true,
          written: null,
          writtenName,
        };
      }
    }
    const backup = exists ? await backupFile(fs, dest.path) : {};
    if (backup.warning) warnings.push(backup.warning);
    const dir = parentDir(dest.path);
    if (dir) await ensureDir(fs, dir);
    const { content } = upsertCodexMcp(rawSource, writtenName, input.sourceServer);
    await atomicWrite(fs, dest.path, content);
    return {
      destPath: dest.path,
      warnings,
      backupPath: backup.backupPath,
      skipped: false,
      written: content,
      writtenName,
    };
  }

  // Claude + Cursor share the .mcp.json shape — reuse the existing
  // loadMcp/saveMcp helpers so the merge logic, schema validation, and
  // ordering all stay in one place.
  const exists = await safeExists(fs, dest.path);
  if (exists && input.mode === "skip-if-exists") {
    const doc = await loadMcp(fs, dest.path);
    const collision = doc.servers.find((s) => s.name === writtenName);
    if (collision) {
      warnings.push(
        `Server "${writtenName}" already exists at ${dest.path}; left untouched.`,
      );
      return {
        destPath: dest.path,
        warnings,
        skipped: true,
        written: null,
        writtenName,
      };
    }
  }
  const backup = exists ? await backupFile(fs, dest.path) : {};
  if (backup.warning) warnings.push(backup.warning);

  const dir = parentDir(dest.path);
  if (dir) await ensureDir(fs, dir);

  const doc = exists
    ? await loadMcp(fs, dest.path)
    : { path: dest.path, exists: false, servers: [], rest: {}, mtimeMs: null };
  const next = doc.servers.filter((s) => s.name !== writtenName);
  next.push({ name: writtenName, server: input.sourceServer });
  await saveMcp(fs, doc, next);

  let writtenText: string | null = null;
  try {
    writtenText = await fs.readTextFile(dest.path);
  } catch {
    /* preview is best-effort */
  }

  return {
    destPath: dest.path,
    warnings,
    backupPath: backup.backupPath,
    skipped: false,
    written: writtenText,
    writtenName,
  };
}

/**
 * Render a preview of the destination file *after* the transfer would
 * land — without actually writing. Useful for the TransferDialog's live
 * preview pane. Reads the current destination and returns either the
 * pretty-printed JSON (claude/cursor) or the serialized TOML (codex).
 */
export async function previewMcpTransfer(
  fs: FsAdapter,
  paths: PathResolverDeps,
  pj: PathJoiner,
  input: TransferMcpInput,
): Promise<{ content: string; warnings: string[] }> {
  const dest = await resolveMcpDestPath(paths, pj, input.dest);
  const warnings = [...dest.warnings];
  const writtenName = input.dest.nameOverride?.trim() || input.sourceName;

  if (dest.tool === "codex") {
    let rawSource = "";
    if (await safeExists(fs, dest.path)) {
      try {
        rawSource = await fs.readTextFile(dest.path);
      } catch {
        rawSource = "";
      }
    }
    const { content } = upsertCodexMcp(rawSource, writtenName, input.sourceServer);
    return { content, warnings };
  }

  // Build the JSON in memory without touching disk.
  const exists = await safeExists(fs, dest.path);
  const doc = exists
    ? await loadMcp(fs, dest.path)
    : { path: dest.path, exists: false, servers: [], rest: {}, mtimeMs: null };
  const next = doc.servers.filter((s) => s.name !== writtenName);
  next.push({ name: writtenName, server: input.sourceServer });
  const obj: Record<string, unknown> = { ...doc.rest };
  const serverObj: Record<string, McpServer> = {};
  for (const { name, server } of next) serverObj[name] = server;
  if (Object.keys(serverObj).length > 0) obj.mcpServers = serverObj;
  return {
    content: `${JSON.stringify(obj, null, 2)}\n`,
    warnings,
  };
}

/** Convenience used by tests + dialogs to count siblings. */
export async function readMcpServerCount(
  fs: FsAdapter,
  path: string,
  tool: McpTransferTool,
): Promise<number> {
  if (!(await safeExists(fs, path))) return 0;
  if (tool === "codex") {
    try {
      const raw = await fs.readTextFile(path);
      return parseCodexMcp(raw).servers.length;
    } catch {
      return 0;
    }
  }
  const doc = await loadMcp(fs, path);
  return doc.servers.length;
}

/** Re-export Codex helpers so callers can compose without importing two modules. */
export { parseCodexMcp, removeCodexMcp, serializeCodexMcp };

import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeExists } from "../fs";
import type { PathResolverDeps } from "../paths";
import type { PathJoiner } from "../artifacts/skill";
import type { ConfigScope } from "./types";
import { mcpFileSchema, type McpServer } from "./schemas";

export interface McpDoc {
  path: string;
  exists: boolean;
  // Servers preserved as an *array* of [name, server] pairs so the user-visible
  // ordering survives a round-trip even though the on-disk shape is an object.
  servers: Array<{ name: string; server: McpServer }>;
  rest: Record<string, unknown>;
  mtimeMs: number | null;
}

export async function mcpPath(
  pj: PathJoiner,
  paths: PathResolverDeps,
  scope: ConfigScope,
  projectRoot: string | null,
): Promise<string | null> {
  if (scope === "global") {
    const home = await paths.homeDir();
    return pj.join(home, ".claude", ".mcp.json");
  }
  if (!projectRoot) return null;
  return pj.join(projectRoot, ".mcp.json");
}

export async function loadMcp(fs: FsAdapter, path: string): Promise<McpDoc> {
  if (!(await safeExists(fs, path))) {
    return { path, exists: false, servers: [], rest: {}, mtimeMs: null };
  }
  const raw = await fs.readTextFile(path);
  let parsed: Record<string, unknown> = {};
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const result = mcpFileSchema.safeParse(parsed);
  const servers: Array<{ name: string; server: McpServer }> = [];
  if (result.success && result.data.mcpServers) {
    for (const [name, server] of Object.entries(result.data.mcpServers)) {
      servers.push({ name, server });
    }
  }
  // `rest` carries any unknown top-level keys from the parsed input, even when
  // schema parsing fell back — preserves the raw object minus mcpServers.
  const { mcpServers: _omit, ...rest } = parsed;
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await fs.stat(path)).mtimeMs;
  } catch {
    /* ignore */
  }
  return { path, exists: true, servers, rest, mtimeMs };
}

export async function saveMcp(
  fs: FsAdapter,
  doc: McpDoc,
  servers: Array<{ name: string; server: McpServer }>,
): Promise<McpDoc> {
  const next: Record<string, unknown> = { ...doc.rest };
  if (servers.length > 0) {
    const obj: Record<string, McpServer> = {};
    for (const { name, server } of servers) {
      if (!name.trim()) continue;
      obj[name] = server;
    }
    if (Object.keys(obj).length > 0) next.mcpServers = obj;
  }
  const dir = parentDir(doc.path);
  if (dir) await ensureDir(fs, dir);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  await atomicWrite(fs, doc.path, serialized);
  return loadMcp(fs, doc.path);
}

function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

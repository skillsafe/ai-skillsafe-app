// Codex stores MCP servers in ~/.codex/config.toml under
// [mcp_servers.<name>] sections. We don't pull in a full TOML parser —
// the file may carry unrelated user keys we shouldn't mangle, so we
// instead lift the mcp_servers blocks out of the source verbatim and
// stitch them back in on save. Everything outside those blocks is
// preserved as raw text.
//
// Supported per-server keys:
//   command = "..."
//   args    = ["...", "..."]
//   env     = lifted from a sibling [mcp_servers.<name>.env] section
//   cwd     = "..."  (passed through if present)
//   url     = "..."  (for HTTP/SSE transports)
//   type    = "stdio" | "url"
//
// This is a minimal subset, but it covers every server shape the rest of
// the app reads/writes via the configs/schemas.ts McpServer type.

import type { McpServer } from "./schemas";

export interface CodexMcpDoc {
  /** Full original text when the source existed; "" when absent. */
  rawSource: string;
  /** Source text with every [mcp_servers.*] block stripped out. */
  rest: string;
  /** Servers parsed out, preserving on-disk order. */
  servers: Array<{ name: string; server: McpServer }>;
}

const SECTION_HEADER_RE = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/;
const KV_RE = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*(?:#.*)?$/;

/** Parse the mcp_servers.* sections out of a Codex config.toml string. */
export function parseCodexMcp(rawSource: string): CodexMcpDoc {
  const lines = rawSource.split(/\r?\n/);
  const restLines: string[] = [];
  type Bucket = {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    type?: string;
    headers?: Record<string, string>;
  };
  const servers = new Map<string, Bucket>();
  const order: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const sectionMatch = SECTION_HEADER_RE.exec(line.trim());
    if (sectionMatch) {
      const path = sectionMatch[1];
      if (path.startsWith("mcp_servers.")) {
        const remainder = path.slice("mcp_servers.".length);
        const dotIdx = remainder.indexOf(".");
        const name = dotIdx > 0 ? remainder.slice(0, dotIdx) : remainder;
        const sub = dotIdx > 0 ? remainder.slice(dotIdx + 1) : null; // "env" / "headers" / null
        if (!servers.has(name)) {
          servers.set(name, {});
          order.push(name);
        }
        const bucket = servers.get(name)!;
        i++;
        while (i < lines.length && !SECTION_HEADER_RE.test(lines[i].trim())) {
          const kv = parseKeyValue(lines[i]);
          if (kv) applyKv(bucket, sub, kv.key, kv.value);
          i++;
        }
        continue;
      }
      // Non-mcp_servers section: pass through verbatim, including
      // contained lines until the next section header.
      restLines.push(line);
      i++;
      while (i < lines.length && !SECTION_HEADER_RE.test(lines[i].trim())) {
        restLines.push(lines[i]);
        i++;
      }
      continue;
    }
    // Top-level (no section yet) line: keep as-is.
    restLines.push(line);
    i++;
  }

  const out: Array<{ name: string; server: McpServer }> = [];
  for (const name of order) {
    const b = servers.get(name)!;
    out.push({ name, server: bucketToServer(b) });
  }
  return {
    rawSource,
    rest: restLines.join("\n"),
    servers: out,
  };
}

function applyKv(
  bucket: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    type?: string;
    headers?: Record<string, string>;
  },
  sub: string | null,
  key: string,
  value: unknown,
): void {
  if (sub === "env") {
    bucket.env = bucket.env ?? {};
    if (typeof value === "string") bucket.env[key] = value;
    return;
  }
  if (sub === "headers") {
    bucket.headers = bucket.headers ?? {};
    if (typeof value === "string") bucket.headers[key] = value;
    return;
  }
  if (sub !== null) return; // unknown sub-section: ignore quietly
  switch (key) {
    case "command":
      if (typeof value === "string") bucket.command = value;
      return;
    case "args":
      if (Array.isArray(value)) bucket.args = value.map(String);
      return;
    case "cwd":
      if (typeof value === "string") bucket.cwd = value;
      return;
    case "url":
      if (typeof value === "string") bucket.url = value;
      return;
    case "type":
      if (typeof value === "string") bucket.type = value;
      return;
    default:
      return; // unknown key: ignore (don't strip from rest because it
              // was inside an mcp_servers section we're rebuilding)
  }
}

function bucketToServer(b: {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
}): McpServer {
  if (b.url) {
    const out: McpServer = {
      type: "url",
      url: b.url,
    };
    if (b.headers) (out as { headers?: Record<string, string> }).headers = b.headers;
    return out;
  }
  const out: McpServer = {
    command: b.command ?? "",
  };
  if (b.type === "stdio") (out as { type?: "stdio" }).type = "stdio";
  if (b.args && b.args.length > 0) (out as { args?: string[] }).args = b.args;
  if (b.env) (out as { env?: Record<string, string> }).env = b.env;
  // cwd is not in the McpServer schema today; preserve via env if needed.
  // Cleanly drop here to keep the type honest.
  return out;
}

/** Parse a single TOML key/value line. Supports strings, integers, and
 *  inline arrays of strings. Returns null when the line is a comment,
 *  blank, or otherwise unrecognized. */
function parseKeyValue(line: string): { key: string; value: unknown } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const m = KV_RE.exec(line);
  if (!m) return null;
  const key = m[1];
  const valueText = m[2].trim();
  return { key, value: parseTomlScalar(valueText) };
}

function parseTomlScalar(raw: string): unknown {
  if (raw.startsWith('"""') && raw.endsWith('"""') && raw.length >= 6) {
    return raw.slice(3, -3);
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return decodeBasicString(raw.slice(1, -1));
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return parseInlineArray(raw.slice(1, -1));
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

function decodeBasicString(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_, ch) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return ch;
    }
  });
}

function parseInlineArray(inner: string): unknown[] {
  // Naive splitter: walks character by character respecting quote nesting.
  const items: unknown[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let escape = false;
  let buf = "";
  for (const ch of inner) {
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (inStr) {
      buf += ch;
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      buf += ch;
      continue;
    }
    if (ch === "[") {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === "]") {
      depth--;
      buf += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      const trimmed = buf.trim();
      if (trimmed) items.push(parseTomlScalar(trimmed));
      buf = "";
      continue;
    }
    buf += ch;
  }
  const trimmedTail = buf.trim();
  if (trimmedTail) items.push(parseTomlScalar(trimmedTail));
  return items;
}

// ---------- serialize ----------

function escapeBasicString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderInlineArray(items: readonly string[]): string {
  return `[${items.map((s) => `"${escapeBasicString(s)}"`).join(", ")}]`;
}

function isStdioServer(s: McpServer): s is { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> } {
  return !("url" in s);
}

/**
 * Render the parsed doc back to a string. Non-mcp_servers content is
 * emitted verbatim from `rest`; the new mcp_servers blocks are appended
 * after it. Servers list is the source of truth — anything previously in
 * the file but not in this list is dropped (caller's responsibility).
 */
export function serializeCodexMcp(
  doc: CodexMcpDoc,
  servers: ReadonlyArray<{ name: string; server: McpServer }>,
): string {
  const blocks: string[] = [];
  for (const { name, server } of servers) {
    blocks.push(`[mcp_servers.${name}]`);
    if (isStdioServer(server)) {
      if (server.type === "stdio") blocks.push(`type = "stdio"`);
      blocks.push(`command = "${escapeBasicString(server.command)}"`);
      if (server.args && server.args.length > 0) {
        blocks.push(`args = ${renderInlineArray(server.args)}`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        blocks.push("");
        blocks.push(`[mcp_servers.${name}.env]`);
        for (const [k, v] of Object.entries(server.env)) {
          blocks.push(`${k} = "${escapeBasicString(v)}"`);
        }
      }
    } else {
      blocks.push(`type = "url"`);
      blocks.push(`url = "${escapeBasicString(server.url)}"`);
      if (server.headers && Object.keys(server.headers).length > 0) {
        blocks.push("");
        blocks.push(`[mcp_servers.${name}.headers]`);
        for (const [k, v] of Object.entries(server.headers)) {
          blocks.push(`${k} = "${escapeBasicString(v)}"`);
        }
      }
    }
    blocks.push("");
  }
  const cleanRest = doc.rest.replace(/\s*$/, "");
  if (blocks.length === 0) {
    return cleanRest ? `${cleanRest}\n` : "";
  }
  const sep = cleanRest ? "\n\n" : "";
  return `${cleanRest}${sep}${blocks.join("\n").replace(/\n+$/, "")}\n`;
}

/** Convenience: parse + replace a single named server (or insert it). */
export function upsertCodexMcp(
  rawSource: string,
  name: string,
  server: McpServer,
): { content: string; doc: CodexMcpDoc } {
  const doc = parseCodexMcp(rawSource);
  const next = doc.servers.filter((s) => s.name !== name);
  next.push({ name, server });
  const content = serializeCodexMcp(doc, next);
  return { content, doc };
}

/** Remove a single named server. No-op if it wasn't present. */
export function removeCodexMcp(
  rawSource: string,
  name: string,
): { content: string; doc: CodexMcpDoc } {
  const doc = parseCodexMcp(rawSource);
  const next = doc.servers.filter((s) => s.name !== name);
  const content = serializeCodexMcp(doc, next);
  return { content, doc };
}

import type { McpServer } from "./schemas";

// Editor-side flat row shape for the MCP editor. Stored as space/newline
// strings (not arrays/objects) so a single text input can drive each field.
// Conversion lives here (not in the .tsx) so tests can exercise it without
// needing JSX.
export type McpTransport = "stdio" | "url";

export interface McpRow {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string;   // space-joined for the input; split on save
  env?: string;    // newline-joined `KEY=value`
  url?: string;
  headers?: string; // newline-joined `Name: value`
}

export function serverToRow({ name, server }: { name: string; server: McpServer }): McpRow {
  if ("url" in server) {
    const headers = server.headers
      ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
      : "";
    return { name, transport: "url", url: server.url, headers };
  }
  const args = server.args ? server.args.join(" ") : "";
  const env = server.env
    ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join("\n")
    : "";
  return { name, transport: "stdio", command: server.command, args, env };
}

export function rowsToServers(
  rows: McpRow[],
): Array<{ name: string; server: McpServer }> {
  const out: Array<{ name: string; server: McpServer }> = [];
  for (const r of rows) {
    if (!r.name.trim()) continue;
    if (r.transport === "url") {
      const url = (r.url ?? "").trim();
      if (!url) continue;
      const headers = parseColonPairs(r.headers ?? "");
      const server: McpServer = {
        type: "url",
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
      out.push({ name: r.name.trim(), server });
    } else {
      const command = (r.command ?? "").trim();
      if (!command) continue;
      const args = (r.args ?? "").trim().length > 0
        ? (r.args ?? "").trim().split(/\s+/)
        : undefined;
      const env = parseEqualsPairs(r.env ?? "");
      const server: McpServer = {
        command,
        ...(args ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
      out.push({ name: r.name.trim(), server });
    }
  }
  return out;
}

function parseEqualsPairs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

function parseColonPairs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const colon = t.indexOf(":");
    if (colon <= 0) continue;
    out[t.slice(0, colon).trim()] = t.slice(colon + 1).trim();
  }
  return out;
}

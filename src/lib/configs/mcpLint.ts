import type { McpServer } from "./schemas";
import type { McpBlocklistPayload, McpBlocklistEntry, Severity } from "../feeds/types";

// MCP STDIO Sanity-Checker — lints MCP server entries against the rule feed
// and a handful of heuristic checks. Pure function over (doc, blocklist).
//
// Designed to surface findings inline in McpEditor so the user sees the risk
// before saving. Output shape mirrors the scanner's RawFinding for
// consistency, minus file/line (MCP edits are by row, not by line).

export interface McpFinding {
  /** Server name the finding pertains to. */
  serverName: string;
  rule_id: string;
  severity: Severity;
  message: string;
}

const SECRET_VALUE_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: "mcp_env_secret_aws", re: /AKIA[0-9A-Z]{16}/ },
  { rule: "mcp_env_secret_github", re: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { rule: "mcp_env_secret_slack", re: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: "mcp_env_secret_private_key", re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  { rule: "mcp_env_secret_generic", re: /(api[_-]?key|secret|token|password)["'\s:=]+["']?[A-Za-z0-9+/_-]{20,}/i },
];

export interface LintContext {
  /** "darwin" | "linux" | "windows" — enables OS-specific checks (e.g. the
   * macOS Codex `--sandbox` heuristic). Pass null/undefined to skip those. */
  platform?: "darwin" | "linux" | "windows" | null;
}

/** Lint a single MCP doc. Returns findings keyed by serverName for the
 * caller to render per-row badges. */
export function lintMcp(
  servers: ReadonlyArray<{ name: string; server: McpServer }>,
  blocklist: McpBlocklistPayload | null,
  ctx: LintContext = {},
): McpFinding[] {
  const findings: McpFinding[] = [];
  for (const { name, server } of servers) {
    findings.push(...lintServer(name, server, blocklist, ctx));
  }
  return findings;
}

function lintServer(
  serverName: string,
  server: McpServer,
  blocklist: McpBlocklistPayload | null,
  ctx: LintContext,
): McpFinding[] {
  const out: McpFinding[] = [];
  // URL transport has a different risk surface — covered by trusting the
  // hostname elsewhere. STDIO is the dangerous one (local exec).
  if (!isStdio(server)) return out;

  const command = server.command;
  const args = server.args ?? [];
  const env = server.env ?? {};

  // 1. Unpinned npx
  if (command === "npx" && !argsContainPin(args)) {
    out.push({
      serverName,
      rule_id: "mcp_unpinned_npx",
      severity: "high",
      message:
        `'${serverName}' runs npx without pinning a version or commit. ` +
        `Pin via 'pkg@<version>' or 'pkg@<sha>' to prevent supply-chain swaps.`,
    });
  }

  // 2. Unpinned uvx
  if (command === "uvx" && !argsContainPin(args)) {
    out.push({
      serverName,
      rule_id: "mcp_unpinned_uvx",
      severity: "high",
      message:
        `'${serverName}' runs uvx without pinning a version. ` +
        `Pin via 'pkg==<version>' to lock the resolved release.`,
    });
  }

  // 3. macOS sandbox flag on Codex-style stdio (best-effort heuristic)
  if (ctx.platform === "darwin" && command === "codex" && !args.some((a) => a === "--sandbox")) {
    out.push({
      serverName,
      rule_id: "mcp_no_sandbox",
      severity: "medium",
      message:
        `'${serverName}' runs codex without --sandbox on macOS. ` +
        `Sandboxing limits the blast radius of an exploited prompt.`,
    });
  }

  // 4. Inline secret in env
  for (const [key, value] of Object.entries(env)) {
    for (const { rule, re } of SECRET_VALUE_PATTERNS) {
      if (re.test(value)) {
        out.push({
          serverName,
          rule_id: rule,
          severity: rule === "mcp_env_secret_generic" ? "medium" : "high",
          message:
            `'${serverName}' has an inline secret in env var '${key}'. ` +
            `Move it to OS keychain / secrets manager and reference by name.`,
        });
        break;
      }
    }
  }

  // 5. Blocklist match (from feed)
  if (blocklist) {
    for (const entry of blocklist.entries) {
      if (matchesBlocklist(entry, serverName, server)) {
        out.push({
          serverName,
          rule_id: "mcp_blocklisted",
          severity: entry.severity,
          message: `'${serverName}' matches blocklist entry: ${entry.reason}`,
        });
      }
    }
  }

  return out;
}

function isStdio(s: McpServer): s is Extract<McpServer, { command: string }> {
  return "command" in s && typeof s.command === "string";
}

/**
 * True if args carry a pin: `pkg@version` or `pkg@<sha-like>`. We accept a
 * permissive "@…" tail so date pins, commit shas, and semver all qualify.
 * Bare `-y` / `--yes` doesn't pin; we look for any token containing `@`
 * after a non-empty package-ish prefix.
 */
function argsContainPin(args: readonly string[]): boolean {
  return args.some((arg) => /^[^@\s][^@\s]*@[^@\s]+$/.test(arg) || /^[^=\s]+==[^=\s]+$/.test(arg));
}

function matchesBlocklist(
  entry: McpBlocklistEntry,
  serverName: string,
  server: McpServer,
): boolean {
  // All set fields on the entry must match for the entry to fire. An entry
  // with no fields set never matches (treat as a no-op to avoid false-positive
  // storms from misconfigured feeds).
  let anyMatcher = false;
  if (entry.name) {
    anyMatcher = true;
    if (entry.name !== serverName) return false;
  }
  if (entry.command) {
    anyMatcher = true;
    if (!isStdio(server) || server.command !== entry.command) return false;
  }
  if (entry.args_contains && entry.args_contains.length > 0) {
    anyMatcher = true;
    if (!isStdio(server)) return false;
    const args = server.args ?? [];
    for (const needle of entry.args_contains) {
      if (!args.some((a) => a.includes(needle))) return false;
    }
  }
  return anyMatcher;
}

/** Returns the highest-severity finding for a server, or null. Used by the
 * editor row badge to pick a single colour. */
export function topSeverity(findings: ReadonlyArray<McpFinding>, serverName: string): McpFinding | null {
  const ordered: Severity[] = ["critical", "high", "medium", "low", "info"];
  for (const sev of ordered) {
    const found = findings.find((f) => f.serverName === serverName && f.severity === sev);
    if (found) return found;
  }
  return null;
}

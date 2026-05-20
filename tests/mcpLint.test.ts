import { describe, expect, it } from "vitest";
import { lintMcp, topSeverity } from "../src/lib/configs/mcpLint";
import type { McpServer } from "../src/lib/configs/schemas";
import type { McpBlocklistPayload } from "../src/lib/feeds/types";

function stdio(command: string, args: string[] = [], env: Record<string, string> = {}): McpServer {
  return { type: "stdio", command, args, env };
}

function url(u: string): McpServer {
  return { type: "url", url: u };
}

describe("mcpLint", () => {
  it("flags unpinned npx", () => {
    const out = lintMcp([{ name: "foo", server: stdio("npx", ["-y", "some-mcp-server"]) }], null);
    expect(out.map((f) => f.rule_id)).toContain("mcp_unpinned_npx");
  });

  it("clears when npx is pinned with @version", () => {
    const out = lintMcp([{ name: "foo", server: stdio("npx", ["-y", "some-mcp-server@1.2.3"]) }], null);
    expect(out.map((f) => f.rule_id)).not.toContain("mcp_unpinned_npx");
  });

  it("clears when npx is pinned to a commit sha", () => {
    const out = lintMcp([{ name: "foo", server: stdio("npx", ["pkg@abcdef1234567890"]) }], null);
    expect(out.map((f) => f.rule_id)).not.toContain("mcp_unpinned_npx");
  });

  it("flags unpinned uvx", () => {
    const out = lintMcp([{ name: "foo", server: stdio("uvx", ["mcp-server-tool"]) }], null);
    expect(out.map((f) => f.rule_id)).toContain("mcp_unpinned_uvx");
  });

  it("clears uvx with == pin", () => {
    const out = lintMcp([{ name: "foo", server: stdio("uvx", ["mcp-server-tool==1.0.0"]) }], null);
    expect(out.map((f) => f.rule_id)).not.toContain("mcp_unpinned_uvx");
  });

  it("flags codex without --sandbox on macOS", () => {
    const out = lintMcp(
      [{ name: "foo", server: stdio("codex", ["mcp"]) }],
      null,
      { platform: "darwin" },
    );
    expect(out.map((f) => f.rule_id)).toContain("mcp_no_sandbox");
  });

  it("clears codex with --sandbox", () => {
    const out = lintMcp(
      [{ name: "foo", server: stdio("codex", ["mcp", "--sandbox"]) }],
      null,
      { platform: "darwin" },
    );
    expect(out.map((f) => f.rule_id)).not.toContain("mcp_no_sandbox");
  });

  it("flags AWS secret in env value", () => {
    const out = lintMcp(
      [{ name: "foo", server: stdio("node", [], { AWS_KEY: "AKIA" + "ABCDEFGHIJKLMNOP" }) }],
      null,
    );
    expect(out.map((f) => f.rule_id)).toContain("mcp_env_secret_aws");
  });

  it("flags GitHub token in env value", () => {
    const out = lintMcp(
      [{ name: "foo", server: stdio("node", [], { GH_TOKEN: "ghp_" + "x".repeat(40) }) }],
      null,
    );
    expect(out.map((f) => f.rule_id)).toContain("mcp_env_secret_github");
  });

  it("clears env when no secret patterns match", () => {
    const out = lintMcp(
      [{ name: "foo", server: stdio("node", [], { LOG_LEVEL: "info", PORT: "3000" }) }],
      null,
    );
    expect(out.map((f) => f.rule_id).filter((id) => id.startsWith("mcp_env_secret"))).toEqual([]);
  });

  it("does not lint url transport servers", () => {
    const out = lintMcp([{ name: "foo", server: url("https://example.com/mcp") }], null);
    expect(out).toEqual([]);
  });

  it("matches blocklist by name", () => {
    const blocklist: McpBlocklistPayload = {
      version: "x",
      entries: [{ name: "evil", reason: "known bad", severity: "critical" }],
    };
    const out = lintMcp([{ name: "evil", server: stdio("node") }], blocklist);
    expect(out[0].rule_id).toBe("mcp_blocklisted");
    expect(out[0].severity).toBe("critical");
  });

  it("matches blocklist by command + args_contains (all must match)", () => {
    const blocklist: McpBlocklistPayload = {
      version: "x",
      entries: [
        { command: "npx", args_contains: ["@bad/pkg"], reason: "SANDWORM", severity: "high" },
      ],
    };
    const matching = lintMcp(
      [{ name: "foo", server: stdio("npx", ["-y", "@bad/pkg@1"]) }],
      blocklist,
    );
    expect(matching.some((f) => f.rule_id === "mcp_blocklisted")).toBe(true);
    const nonMatching = lintMcp(
      [{ name: "foo", server: stdio("npx", ["-y", "@good/pkg@1"]) }],
      blocklist,
    );
    expect(nonMatching.some((f) => f.rule_id === "mcp_blocklisted")).toBe(false);
  });

  it("blocklist entries with no matchers never fire", () => {
    const blocklist: McpBlocklistPayload = {
      version: "x",
      entries: [{ reason: "broken entry", severity: "high" }],
    };
    const out = lintMcp([{ name: "foo", server: stdio("anything") }], blocklist);
    expect(out.some((f) => f.rule_id === "mcp_blocklisted")).toBe(false);
  });
});

describe("topSeverity", () => {
  it("returns the highest-severity finding for the server", () => {
    const findings = [
      { serverName: "foo", rule_id: "a", severity: "medium" as const, message: "" },
      { serverName: "foo", rule_id: "b", severity: "critical" as const, message: "" },
      { serverName: "foo", rule_id: "c", severity: "low" as const, message: "" },
    ];
    expect(topSeverity(findings, "foo")?.rule_id).toBe("b");
  });

  it("returns null when no findings for the server", () => {
    expect(topSeverity([], "foo")).toBeNull();
  });
});

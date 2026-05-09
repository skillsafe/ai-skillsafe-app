import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveMcpDestPath,
  transferMcp,
  previewMcpTransfer,
} from "../src/lib/translate/mcp";
import { resetHomeCache } from "../src/lib/paths";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

beforeEach(() => {
  // resolveMcpDestPath / transferMcp call getHome() which caches the
  // first home it ever sees. Reset between tests so different `pathDeps`
  // homes resolve correctly.
  resetHomeCache();
});

const playwright = {
  command: "npx",
  args: ["@playwright/mcp", "--browser=chromium"],
  env: { DEBUG: "1" },
};

describe("translate/mcp dest path", () => {
  it("claude global → ~/.claude/.mcp.json; cursor global → ~/.cursor/mcp.json", async () => {
    const home = "/home/test";
    const claude = await resolveMcpDestPath(pathDeps(home), nodeJoiner, {
      tool: "claude",
      scope: "global",
    });
    expect(claude.path).toBe(path.join(home, ".claude", ".mcp.json"));
    const cursor = await resolveMcpDestPath(pathDeps(home), nodeJoiner, {
      tool: "cursor",
      scope: "global",
    });
    expect(cursor.path).toBe(path.join(home, ".cursor", "mcp.json"));
  });

  it("claude project → <root>/.mcp.json; cursor project → <root>/.cursor/mcp.json", async () => {
    const projectRoot = "/p";
    const claude = await resolveMcpDestPath(pathDeps("/h"), nodeJoiner, {
      tool: "claude",
      scope: "project",
      projectRoot,
    });
    expect(claude.path).toBe(path.join(projectRoot, ".mcp.json"));
    const cursor = await resolveMcpDestPath(pathDeps("/h"), nodeJoiner, {
      tool: "cursor",
      scope: "project",
      projectRoot,
    });
    expect(cursor.path).toBe(path.join(projectRoot, ".cursor", "mcp.json"));
  });

  it("codex always lands at ~/.codex/config.toml; project scope is coerced to global with a warning", async () => {
    const home = "/home/c";
    const codex = await resolveMcpDestPath(pathDeps(home), nodeJoiner, {
      tool: "codex",
      scope: "project",
      projectRoot: "/p",
    });
    expect(codex.path).toBe(path.join(home, ".codex", "config.toml"));
    expect(codex.warnings.some((w) => w.toLowerCase().includes("global"))).toBe(true);
  });
});

describe("translate/mcp transferMcp claude/cursor (.mcp.json shape)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("xfer-mcp-json");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("creates a claude .mcp.json from scratch when no destination exists", async () => {
    const project = path.join(tmp, "proj");
    const r = await transferMcp(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "cursor",
      sourceName: "playwright",
      sourceServer: playwright,
      dest: { tool: "claude", scope: "project", projectRoot: project },
      mode: "replace",
    });
    expect(r.skipped).toBe(false);
    const written = JSON.parse(await fs.readFile(r.destPath, "utf8"));
    expect(written.mcpServers.playwright.command).toBe("npx");
    expect(written.mcpServers.playwright.env.DEBUG).toBe("1");
  });

  it("merges into existing .mcp.json without clobbering siblings + writes a .skillsafe.bak", async () => {
    const project = path.join(tmp, "proj");
    await fs.mkdir(project, { recursive: true });
    const sibling = {
      mcpServers: { sibling: { command: "echo", args: ["hi"] } },
      // Unknown top-level key that must round-trip:
      _custom: "preserve me",
    };
    await fs.writeFile(path.join(project, ".mcp.json"), JSON.stringify(sibling));

    const r = await transferMcp(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "cursor",
      sourceName: "playwright",
      sourceServer: playwright,
      dest: { tool: "claude", scope: "project", projectRoot: project },
      mode: "replace",
    });
    expect(r.backupPath).toBe(path.join(project, ".mcp.json.skillsafe.bak"));
    const after = JSON.parse(await fs.readFile(r.destPath, "utf8"));
    expect(after.mcpServers.sibling.command).toBe("echo");
    expect(after.mcpServers.playwright.command).toBe("npx");
    expect(after._custom).toBe("preserve me");
  });

  it("skip-if-exists leaves the existing server intact and reports skipped=true", async () => {
    const project = path.join(tmp, "proj");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: { playwright: { command: "old" } },
      }),
    );
    const r = await transferMcp(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "cursor",
      sourceName: "playwright",
      sourceServer: playwright,
      dest: { tool: "claude", scope: "project", projectRoot: project },
      mode: "skip-if-exists",
    });
    expect(r.skipped).toBe(true);
    const after = JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8"));
    expect(after.mcpServers.playwright.command).toBe("old");
  });

  it("nameOverride lands the server under a different key on the destination", async () => {
    const project = path.join(tmp, "proj");
    const r = await transferMcp(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "cursor",
      sourceName: "playwright",
      sourceServer: playwright,
      dest: {
        tool: "claude",
        scope: "project",
        projectRoot: project,
        nameOverride: "pw-renamed",
      },
      mode: "replace",
    });
    const after = JSON.parse(await fs.readFile(r.destPath, "utf8"));
    expect(after.mcpServers["pw-renamed"].command).toBe("npx");
    expect(after.mcpServers.playwright).toBeUndefined();
    expect(r.writtenName).toBe("pw-renamed");
  });
});

describe("translate/mcp transferMcp codex (TOML shape)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("xfer-mcp-toml");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("upserts an mcp_servers entry into ~/.codex/config.toml while preserving the rest", async () => {
    await fs.mkdir(path.join(tmp, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".codex", "config.toml"),
      [
        'default_model = "gpt-4"',
        "",
        "[mcp_servers.existing]",
        'command = "node"',
        "",
      ].join("\n"),
    );

    const r = await transferMcp(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "claude",
      sourceName: "playwright",
      sourceServer: playwright,
      dest: { tool: "codex", scope: "global" },
      mode: "replace",
    });
    expect(r.skipped).toBe(false);
    const after = await fs.readFile(r.destPath, "utf8");
    expect(after).toContain('default_model = "gpt-4"');
    expect(after).toContain("[mcp_servers.existing]");
    expect(after).toContain("[mcp_servers.playwright]");
    expect(after).toContain('command = "npx"');
    expect(after).toContain("[mcp_servers.playwright.env]");
    expect(after).toContain('DEBUG = "1"');
  });

  it("creates ~/.codex/config.toml from scratch when missing", async () => {
    const r = await transferMcp(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "claude",
      sourceName: "playwright",
      sourceServer: playwright,
      dest: { tool: "codex", scope: "global" },
      mode: "replace",
    });
    expect(r.skipped).toBe(false);
    const text = await fs.readFile(r.destPath, "utf8");
    expect(text).toContain("[mcp_servers.playwright]");
    expect(text).toContain('command = "npx"');
  });
});

describe("translate/mcp previewMcpTransfer", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("preview-mcp");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("renders pretty JSON for claude/cursor without writing", async () => {
    const project = path.join(tmp, "proj");
    const result = await previewMcpTransfer(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "cursor",
      sourceName: "pw",
      sourceServer: playwright,
      dest: { tool: "claude", scope: "project", projectRoot: project },
      mode: "replace",
    });
    expect(result.content).toContain('"mcpServers"');
    expect(result.content).toContain('"pw"');
    // Confirm we didn't actually create the file:
    await expect(fs.access(path.join(project, ".mcp.json"))).rejects.toThrow();
  });

  it("renders TOML for codex without writing", async () => {
    const result = await previewMcpTransfer(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "claude",
      sourceName: "pw",
      sourceServer: playwright,
      dest: { tool: "codex", scope: "global" },
      mode: "replace",
    });
    expect(result.content).toContain("[mcp_servers.pw]");
    await expect(fs.access(path.join(tmp, ".codex", "config.toml"))).rejects.toThrow();
  });
});

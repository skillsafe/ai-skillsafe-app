import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addToMaster,
  encodeProjectPath,
  loadManifest,
  masterPathFor,
  masterStateFor,
  removeFromMaster,
  resolveMasterRoot,
  restoreSourceFromMaster,
} from "../src/lib/master/store";
import { sha256Hex } from "../src/lib/fs";
import type { InventoryItem } from "../src/lib/inventory/types";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

async function memoryItem(
  tool: string,
  scope: "global" | "project",
  projectPath: string | null,
  name: string,
  body: string,
  absPath: string,
): Promise<InventoryItem> {
  const id = (await sha256Hex(`memory|${tool}|${scope}|${projectPath ?? ""}|${name}`)).slice(0, 24);
  return {
    id,
    tool,
    category: "memory",
    scope,
    projectPath,
    name,
    absPath,
    payload: { body },
    contentHash: await sha256Hex(body),
    lastSeen: 0,
  };
}

async function mcpItem(
  tool: string,
  scope: "global" | "project",
  projectPath: string | null,
  name: string,
  server: Record<string, unknown>,
  absPath: string,
): Promise<InventoryItem> {
  const id = (await sha256Hex(`mcp|${tool}|${scope}|${projectPath ?? ""}|${name}`)).slice(0, 24);
  return {
    id,
    tool,
    category: "mcp",
    scope,
    projectPath,
    name,
    absPath,
    payload: server,
    contentHash: await sha256Hex(JSON.stringify(server)),
    lastSeen: 0,
  };
}

describe("master/store path helpers", () => {
  it("encodes absolute project paths into a single safe segment", () => {
    expect(encodeProjectPath("/Users/xhu/proj")).toBe("Users-xhu-proj");
    expect(encodeProjectPath("C:\\Users\\xhu\\proj")).toBe("C:-Users-xhu-proj");
    expect(encodeProjectPath("/")).toBe("");
  });

  it("masterPathFor groups items under per-tool subdirs by category + scope", async () => {
    const m = await memoryItem("claude", "global", null, "CLAUDE.md", "x", "/x");
    expect(masterPathFor(m)).toBe("memory/global/claude/CLAUDE.md");
    const mp = await memoryItem("codex", "project", "/Users/x/p", "AGENTS.md", "x", "/x");
    expect(masterPathFor(mp)).toBe("memory/projects/Users-x-p/codex/AGENTS.md");
    const mc = await mcpItem("claude", "global", null, "playwright", { command: "npx" }, "/x");
    expect(masterPathFor(mc)).toBe("mcp/global/claude/playwright.json");
  });

  it("appends .md when a memory file has no extension (.clinerules)", async () => {
    const cli = await memoryItem("cline", "project", "/p", ".clinerules", "x", "/x");
    expect(masterPathFor(cli).endsWith(".md")).toBe(true);
  });
});

describe("master/store manifest CRUD", () => {
  let masterRoot: string;
  let sourceDir: string;

  beforeEach(async () => {
    masterRoot = await makeTmp("master");
    sourceDir = await makeTmp("source");
  });

  afterEach(async () => {
    await rmrf(masterRoot);
    await rmrf(sourceDir);
  });

  it("returns an empty manifest when manifest.json doesn't exist", async () => {
    const m = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    expect(m.entries).toEqual([]);
    expect(m.version).toBe(1);
  });

  it("addToMaster writes payload + manifest, marks source as in-sync", async () => {
    const sourcePath = path.join(sourceDir, "CLAUDE.md");
    const body = "# memory\n\nbe terse.\n";
    await fs.writeFile(sourcePath, body);
    const item = await memoryItem("claude", "global", null, "CLAUDE.md", body, sourcePath);

    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, item);
    expect(entry.masterPath).toBe("memory/global/claude/CLAUDE.md");
    expect(entry.sources).toHaveLength(1);
    expect(entry.sources[0].lastSyncedHash).toBe(item.contentHash);

    const written = await fs.readFile(
      path.join(masterRoot, "memory", "global", "claude", "CLAUDE.md"),
      "utf8",
    );
    expect(written).toBe(body);

    const manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    expect(manifest.entries).toHaveLength(1);
    expect(masterStateFor(manifest, item).kind).toBe("in-sync");
  });

  it("addToMaster a second time with changed source content surfaces as drift, then update clears it", async () => {
    const sourcePath = path.join(sourceDir, "CLAUDE.md");
    const v1 = "v1";
    await fs.writeFile(sourcePath, v1);
    const original = await memoryItem("claude", "global", null, "CLAUDE.md", v1, sourcePath);
    await addToMaster(nodeFs, nodeJoiner, masterRoot, original);

    // Source drifts to v2 — same id, new contentHash.
    const v2 = "v2 modified";
    const drifted = await memoryItem("claude", "global", null, "CLAUDE.md", v2, sourcePath);
    let manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    expect(masterStateFor(manifest, drifted).kind).toBe("drifted");

    // Update master with the new content.
    await addToMaster(nodeFs, nodeJoiner, masterRoot, drifted);
    manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    expect(masterStateFor(manifest, drifted).kind).toBe("in-sync");
  });

  it("removeFromMaster deletes the payload file and the manifest entry", async () => {
    const sourcePath = path.join(sourceDir, "CLAUDE.md");
    await fs.writeFile(sourcePath, "x");
    const item = await memoryItem("claude", "global", null, "CLAUDE.md", "x", sourcePath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, item);

    await removeFromMaster(nodeFs, nodeJoiner, masterRoot, entry.id);
    const manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    expect(manifest.entries).toHaveLength(0);
    await expect(
      fs.access(path.join(masterRoot, "memory", "global", "claude", "CLAUDE.md")),
    ).rejects.toThrow();
  });

  it("restoreSourceFromMaster overwrites a memory source from the master payload", async () => {
    const sourcePath = path.join(sourceDir, "CLAUDE.md");
    await fs.writeFile(sourcePath, "good");
    const good = await memoryItem("claude", "global", null, "CLAUDE.md", "good", sourcePath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, good);

    // User clobbers the source by hand.
    await fs.writeFile(sourcePath, "garbled");
    await restoreSourceFromMaster(
      nodeFs,
      nodeJoiner,
      masterRoot,
      entry,
      entry.sources[0],
      good.name,
    );
    expect(await fs.readFile(sourcePath, "utf8")).toBe("good");
  });

  it("restoreSourceFromMaster merges an MCP server back into .mcp.json without clobbering siblings", async () => {
    // Pre-existing .mcp.json with a sibling we must not touch.
    const sourcePath = path.join(sourceDir, ".mcp.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        mcpServers: {
          sibling: { command: "echo", args: ["hi"] },
        },
      }),
    );
    const playwright = { command: "npx", args: ["@playwright/mcp"] };
    const item = await mcpItem("claude", "global", null, "playwright", playwright, sourcePath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, item);

    await restoreSourceFromMaster(
      nodeFs,
      nodeJoiner,
      masterRoot,
      entry,
      entry.sources[0],
      "playwright",
    );

    const after = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    expect(after.mcpServers.sibling.command).toBe("echo");
    expect(after.mcpServers.playwright.command).toBe("npx");
    expect(after.mcpServers.playwright.args).toEqual(["npx", "@playwright/mcp"].slice(1));
  });
});

describe("resolveMasterRoot", () => {
  it("returns the override unchanged when given", async () => {
    const got = await resolveMasterRoot(pathDeps("/home/x"), "/custom/path");
    expect(got).toBe("/custom/path");
  });

  it("falls back to <home>/SkillSafe/master when neither override nor backup is set", async () => {
    const got = await resolveMasterRoot(pathDeps("/home/x"), null);
    expect(got).toBe("/home/x/SkillSafe/master");
  });

  it("nests under the backup folder when no override is set", async () => {
    const got = await resolveMasterRoot(pathDeps("/home/x"), null, "/Users/x/Backups/skillsafe");
    expect(got).toBe("/Users/x/Backups/skillsafe/master");
  });

  it("override beats the backup folder default", async () => {
    const got = await resolveMasterRoot(
      pathDeps("/home/x"),
      "/elsewhere/master",
      "/Users/x/Backups/skillsafe",
    );
    expect(got).toBe("/elsewhere/master");
  });
});

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addToMaster,
  bindSource,
  encodeProjectPath,
  listMasterFiles,
  loadManifest,
  masterPathFor,
  masterStateFor,
  removeFromMaster,
  resolveMasterRoot,
  restoreSourceFromMaster,
  unbindSource,
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

describe("bindSource / unbindSource", () => {
  let masterRoot: string;
  let sourceDir: string;

  beforeEach(async () => {
    masterRoot = await makeTmp("master-bind");
    sourceDir = await makeTmp("source-bind");
  });

  afterEach(async () => {
    await rmrf(masterRoot);
    await rmrf(sourceDir);
  });

  it("appends a new source to an existing entry without writing the destination", async () => {
    // Seed master from a Claude source.
    const claudePath = path.join(sourceDir, "CLAUDE.md");
    await fs.writeFile(claudePath, "# rules");
    const claude = await memoryItem("claude", "global", null, "CLAUDE.md", "# rules", claudePath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, claude);

    // Bind a Codex destination — file does not exist yet on disk; bind
    // should not create it.
    const codexPath = path.join(sourceDir, "AGENTS.md");
    const bound = await bindSource(nodeFs, nodeJoiner, masterRoot, entry.id, {
      tool: "codex",
      scope: "global",
      projectPath: null,
      absPath: codexPath,
    });
    expect(bound.tool).toBe("codex");
    expect(bound.lastSyncedHash).toBe("");
    expect(bound.lastSyncedAt).toBe(0);
    await expect(fs.access(codexPath)).rejects.toThrow();

    const manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    const updated = manifest.entries.find((e) => e.id === entry.id)!;
    expect(updated.sources.map((s) => s.tool).sort()).toEqual(["claude", "codex"]);
  });

  it("re-binding the same (tool, scope, projectPath) replaces the existing row", async () => {
    const claudePath = path.join(sourceDir, "CLAUDE.md");
    await fs.writeFile(claudePath, "x");
    const claude = await memoryItem("claude", "global", null, "CLAUDE.md", "x", claudePath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, claude);

    const codex1 = path.join(sourceDir, "AGENTS.md");
    const codex2 = path.join(sourceDir, "AGENTS-other.md");
    await bindSource(nodeFs, nodeJoiner, masterRoot, entry.id, {
      tool: "codex",
      scope: "global",
      projectPath: null,
      absPath: codex1,
    });
    await bindSource(nodeFs, nodeJoiner, masterRoot, entry.id, {
      tool: "codex",
      scope: "global",
      projectPath: null,
      absPath: codex2,
    });
    const manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    const updated = manifest.entries.find((e) => e.id === entry.id)!;
    const codexSources = updated.sources.filter((s) => s.tool === "codex");
    expect(codexSources).toHaveLength(1);
    expect(codexSources[0].absPath).toBe(codex2);
  });

  it("syncedHash records the bound source as in-sync against its current content", async () => {
    const claudePath = path.join(sourceDir, "CLAUDE.md");
    const body = "# memory";
    await fs.writeFile(claudePath, body);
    const claude = await memoryItem("claude", "global", null, "CLAUDE.md", body, claudePath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, claude);

    const codexPath = path.join(sourceDir, "AGENTS.md");
    await fs.writeFile(codexPath, body); // simulate post-transfer state
    const hash = await sha256Hex(body);
    const bound = await bindSource(nodeFs, nodeJoiner, masterRoot, entry.id, {
      tool: "codex",
      scope: "global",
      projectPath: null,
      absPath: codexPath,
      syncedHash: hash,
    });
    expect(bound.lastSyncedHash).toBe(hash);
    expect(bound.lastSyncedAt).toBeGreaterThan(0);
  });

  it("unbindSource removes the matching source and leaves siblings + destination file untouched", async () => {
    const claudePath = path.join(sourceDir, "CLAUDE.md");
    await fs.writeFile(claudePath, "x");
    const claude = await memoryItem("claude", "global", null, "CLAUDE.md", "x", claudePath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, claude);

    const codexPath = path.join(sourceDir, "AGENTS.md");
    await fs.writeFile(codexPath, "x");
    await bindSource(nodeFs, nodeJoiner, masterRoot, entry.id, {
      tool: "codex",
      scope: "global",
      projectPath: null,
      absPath: codexPath,
    });

    await unbindSource(nodeFs, nodeJoiner, masterRoot, entry.id, {
      tool: "codex",
      scope: "global",
      projectPath: null,
    });

    const manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    const updated = manifest.entries.find((e) => e.id === entry.id)!;
    expect(updated.sources.map((s) => s.tool)).toEqual(["claude"]);
    // Destination file must still be on disk.
    expect(await fs.readFile(codexPath, "utf8")).toBe("x");
  });

  it("unbindSource is a no-op when entry / source isn't found", async () => {
    const claudePath = path.join(sourceDir, "CLAUDE.md");
    await fs.writeFile(claudePath, "x");
    const claude = await memoryItem("claude", "global", null, "CLAUDE.md", "x", claudePath);
    await addToMaster(nodeFs, nodeJoiner, masterRoot, claude);

    // Wrong id — silent no-op.
    await unbindSource(nodeFs, nodeJoiner, masterRoot, "no-such-id", {
      tool: "codex",
      scope: "global",
      projectPath: null,
    });
    // Right id, wrong tool — silent no-op.
    await unbindSource(nodeFs, nodeJoiner, masterRoot, claude.id, {
      tool: "codex",
      scope: "global",
      projectPath: null,
    });
    const manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    expect(manifest.entries[0].sources).toHaveLength(1);
  });

  it("bindSource throws when the entry id is unknown", async () => {
    await expect(
      bindSource(nodeFs, nodeJoiner, masterRoot, "no-such-id", {
        tool: "codex",
        scope: "global",
        projectPath: null,
        absPath: "/whatever",
      }),
    ).rejects.toThrow(/No master entry/);
  });
});

describe("restoreSourceFromMaster cross-tool memory translation", () => {
  let masterRoot: string;
  let sourceDir: string;

  beforeEach(async () => {
    masterRoot = await makeTmp("master-translate");
    sourceDir = await makeTmp("source-translate");
  });

  afterEach(async () => {
    await rmrf(masterRoot);
    await rmrf(sourceDir);
  });

  it("renders cursor MDC frontmatter when restoring to a cursor source from a claude-authored entry", async () => {
    // Master is authored from Claude (plain markdown, no frontmatter).
    const claudePath = path.join(sourceDir, "CLAUDE.md");
    const body = "# rules\n\nbe terse.\n";
    await fs.writeFile(claudePath, body);
    const claude = await memoryItem("claude", "global", null, "CLAUDE.md", body, claudePath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, claude);

    // Bind a cursor destination, then restore.
    const cursorPath = path.join(sourceDir, ".cursor", "rules", "memory.mdc");
    const bound = await bindSource(nodeFs, nodeJoiner, masterRoot, entry.id, {
      tool: "cursor",
      scope: "project",
      projectPath: sourceDir,
      absPath: cursorPath,
    });
    await restoreSourceFromMaster(nodeFs, nodeJoiner, masterRoot, entry, bound, "memory.mdc");
    const written = await fs.readFile(cursorPath, "utf8");
    // Cursor expects `---` fenced frontmatter at the top.
    expect(written.startsWith("---\n")).toBe(true);
    // Body must still contain the original Claude markdown.
    expect(written).toContain("be terse.");
  });

  it("strips MDC frontmatter when the canonical was authored as cursor and restore target is claude", async () => {
    // Master is authored from cursor with frontmatter.
    const cursorPath = path.join(sourceDir, "memory.mdc");
    const cursorBody = "---\ndescription: rules\n---\n\nbe terse.\n";
    await fs.writeFile(cursorPath, cursorBody);
    const cursor = await memoryItem("cursor", "project", sourceDir, "memory.mdc", cursorBody, cursorPath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, cursor);

    // Bind claude project memory and restore.
    const claudePath = path.join(sourceDir, "CLAUDE.md");
    const bound = await bindSource(nodeFs, nodeJoiner, masterRoot, entry.id, {
      tool: "claude",
      scope: "project",
      projectPath: sourceDir,
      absPath: claudePath,
    });
    await restoreSourceFromMaster(nodeFs, nodeJoiner, masterRoot, entry, bound, "CLAUDE.md");
    const written = await fs.readFile(claudePath, "utf8");
    // Claude doesn't use frontmatter — the `---` fence must not appear at
    // the top.
    expect(written.startsWith("---")).toBe(false);
    expect(written).toContain("be terse.");
  });

  it("restoring a same-tool source still writes the body verbatim (no translation regression)", async () => {
    const claudePath = path.join(sourceDir, "CLAUDE.md");
    const body = "# only\n";
    await fs.writeFile(claudePath, body);
    const claude = await memoryItem("claude", "global", null, "CLAUDE.md", body, claudePath);
    const entry = await addToMaster(nodeFs, nodeJoiner, masterRoot, claude);
    await fs.writeFile(claudePath, "garbled");
    await restoreSourceFromMaster(nodeFs, nodeJoiner, masterRoot, entry, entry.sources[0], "CLAUDE.md");
    expect(await fs.readFile(claudePath, "utf8")).toBe(body);
  });
});

describe("listMasterFiles", () => {
  let masterRoot: string;

  beforeEach(async () => {
    masterRoot = await makeTmp("master-list");
  });

  afterEach(async () => {
    await rmrf(masterRoot);
  });

  it("returns payload files but skips the master manifest at the root", async () => {
    await fs.writeFile(path.join(masterRoot, "manifest.json"), "{}");
    const memDir = path.join(masterRoot, "memory", "global", "claude");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "CLAUDE.md"), "x");

    const files = await listMasterFiles(nodeFs, nodeJoiner, masterRoot);
    expect(files).toEqual(["memory/global/claude/CLAUDE.md"]);
  });

  it("skips manifest.json at any depth, not just the root", async () => {
    const sub = path.join(masterRoot, "memory", "global");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, "manifest.json"), "{}");
    await fs.writeFile(path.join(sub, "CLAUDE.md"), "x");

    const files = await listMasterFiles(nodeFs, nodeJoiner, masterRoot);
    expect(files).toEqual(["memory/global/CLAUDE.md"]);
  });

  it("skips dotfiles like .DS_Store", async () => {
    await fs.writeFile(path.join(masterRoot, ".DS_Store"), "x");
    await fs.writeFile(path.join(masterRoot, "real.md"), "y");

    const files = await listMasterFiles(nodeFs, nodeJoiner, masterRoot);
    expect(files).toEqual(["real.md"]);
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

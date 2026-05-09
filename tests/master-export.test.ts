import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyBulkRestore,
  importMasterZip,
  packMasterZip,
  planBulkRestore,
} from "../src/lib/master/export";
import {
  addToMaster,
  loadManifest,
} from "../src/lib/master/store";
import { sha256Hex } from "../src/lib/fs";
import type { InventoryItem } from "../src/lib/inventory/types";
import { makeTmp, nodeFs, nodeJoiner, rmrf } from "./_helpers";

async function memoryItem(
  tool: string,
  name: string,
  body: string,
  absPath: string,
): Promise<InventoryItem> {
  const id = (
    await sha256Hex(`memory|${tool}|global||${name}`)
  ).slice(0, 24);
  return {
    id,
    tool,
    category: "memory",
    scope: "global",
    projectPath: null,
    name,
    absPath,
    payload: { body },
    contentHash: await sha256Hex(body),
    lastSeen: 0,
  };
}

describe("master/export pack + import round-trip", () => {
  let masterRoot: string;
  let importTarget: string;
  let sourceDir: string;

  beforeEach(async () => {
    masterRoot = await makeTmp("master-export-src");
    importTarget = await makeTmp("master-export-tgt");
    sourceDir = await makeTmp("master-export-source");
  });

  afterEach(async () => {
    await rmrf(masterRoot);
    await rmrf(importTarget);
    await rmrf(sourceDir);
  });

  it("packs and re-imports a master folder, preserving files + manifest entries", async () => {
    const claudeSource = path.join(sourceDir, "CLAUDE.md");
    await fs.writeFile(claudeSource, "# memory\n\nbe terse.\n");
    const item = await memoryItem("claude", "CLAUDE.md", "# memory\n\nbe terse.\n", claudeSource);
    await addToMaster(nodeFs, nodeJoiner, masterRoot, item);

    const zip = await packMasterZip(nodeFs, nodeJoiner, masterRoot);
    expect(zip.length).toBeGreaterThan(0);

    const result = await importMasterZip(nodeFs, nodeJoiner, importTarget, zip);
    expect(result.filesWritten).toBeGreaterThan(0);
    expect(result.manifestEntriesImported).toBe(1);

    const importedManifest = await loadManifest(nodeFs, nodeJoiner, importTarget);
    expect(importedManifest.entries).toHaveLength(1);
    const expectedFile = path.join(
      importTarget,
      "memory",
      "global",
      "claude",
      "CLAUDE.md",
    );
    const importedBody = await fs.readFile(expectedFile, "utf8");
    expect(importedBody).toContain("be terse");
  });

  it("packMasterZip throws on an empty master folder", async () => {
    await expect(packMasterZip(nodeFs, nodeJoiner, masterRoot)).rejects.toThrow();
  });

  it("import merges with an existing master manifest, deduping by id", async () => {
    // Seed the target with an entry of its own.
    const localSource = path.join(sourceDir, "TARGET.md");
    await fs.writeFile(localSource, "target side\n");
    const localItem = await memoryItem("codex", "AGENTS.md", "target side\n", localSource);
    await addToMaster(nodeFs, nodeJoiner, importTarget, localItem);

    // Make a different one in the source we'll zip + import.
    const otherSource = path.join(sourceDir, "OTHER.md");
    await fs.writeFile(otherSource, "other side\n");
    const otherItem = await memoryItem("claude", "CLAUDE.md", "other side\n", otherSource);
    await addToMaster(nodeFs, nodeJoiner, masterRoot, otherItem);

    const zip = await packMasterZip(nodeFs, nodeJoiner, masterRoot);
    await importMasterZip(nodeFs, nodeJoiner, importTarget, zip);

    const merged = await loadManifest(nodeFs, nodeJoiner, importTarget);
    const ids = new Set(merged.entries.map((e) => e.id));
    expect(ids.has(localItem.id)).toBe(true);
    expect(ids.has(otherItem.id)).toBe(true);
  });
});

describe("master/export bulk restore", () => {
  let masterRoot: string;
  let sourceDir: string;
  beforeEach(async () => {
    masterRoot = await makeTmp("master-bulk-src");
    sourceDir = await makeTmp("master-bulk-source");
  });
  afterEach(async () => {
    await rmrf(masterRoot);
    await rmrf(sourceDir);
  });

  it("plans + applies bulk restore for all entries with a recorded source", async () => {
    const sourcePath = path.join(sourceDir, "CLAUDE.md");
    await fs.writeFile(sourcePath, "first content");
    const item = await memoryItem("claude", "CLAUDE.md", "first content", sourcePath);
    await addToMaster(nodeFs, nodeJoiner, masterRoot, item);

    // Drift the source on disk so the bulk restore has something to do.
    await fs.writeFile(sourcePath, "garbled");

    const manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    const plan = planBulkRestore(manifest);
    expect(plan).toHaveLength(1);
    expect(plan[0].source).toBeTruthy();

    const result = await applyBulkRestore(nodeFs, nodeJoiner, masterRoot, plan);
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(0);

    const restored = await fs.readFile(sourcePath, "utf8");
    expect(restored).toBe("first content");
  });

  it("skips entries with no recorded source", async () => {
    // Build a manifest with an entry that has zero sources by writing it
    // out manually to mimic an orphan.
    const manifestPath = path.join(masterRoot, "manifest.json");
    await fs.mkdir(masterRoot, { recursive: true });
    await fs.mkdir(path.join(masterRoot, "memory", "global", "claude"), { recursive: true });
    await fs.writeFile(
      path.join(masterRoot, "memory", "global", "claude", "CLAUDE.md"),
      "orphaned",
    );
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        masterRoot,
        generatedAt: 0,
        entries: [
          {
            id: "orphan",
            category: "memory",
            masterPath: "memory/global/claude/CLAUDE.md",
            canonicalHash: await sha256Hex("orphaned"),
            sources: [],
            updatedAt: 0,
          },
        ],
      }),
    );
    const manifest = await loadManifest(nodeFs, nodeJoiner, masterRoot);
    const plan = planBulkRestore(manifest);
    const result = await applyBulkRestore(nodeFs, nodeJoiner, masterRoot, plan);
    expect(result.succeeded).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("no recorded source");
  });
});

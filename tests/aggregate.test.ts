import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmp, nodeFs, nodeJoiner, rmrf } from "./_helpers";
import { aggregateToolManifests } from "../src/lib/backup/aggregate";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  serializeManifest,
  toolBackupSubdir,
  type BackupManifest,
  type Tool,
} from "../src/lib/backup/manifest";

let dest: string;

beforeEach(async () => {
  dest = await makeTmp("aggregate-test");
});

afterEach(async () => {
  await rmrf(dest);
});

async function writeToolManifest(
  tool: Tool,
  m: Partial<BackupManifest>,
): Promise<void> {
  const dir = path.join(dest, toolBackupSubdir(tool));
  await fs.mkdir(dir, { recursive: true });
  const full: BackupManifest = {
    version: MANIFEST_VERSION,
    generatedAt: m.generatedAt ?? 0,
    destination: dest,
    counts: m.counts ?? { added: 0, changed: 0, removed: 0, unchanged: 0 },
    entries: m.entries ?? [],
    errors: m.errors ?? [],
  };
  await fs.writeFile(path.join(dir, MANIFEST_FILENAME), serializeManifest(full));
}

describe("aggregateToolManifests", () => {
  it("returns null when no per-tool manifests exist", async () => {
    const merged = await aggregateToolManifests(nodeFs, nodeJoiner, dest);
    expect(merged).toBeNull();
  });

  it("sums counts across tools and uses the most recent generatedAt", async () => {
    await writeToolManifest("claude", {
      generatedAt: 100,
      counts: { added: 2, changed: 1, removed: 0, unchanged: 5 },
    });
    await writeToolManifest("codex", {
      generatedAt: 200,
      counts: { added: 1, changed: 0, removed: 1, unchanged: 3 },
    });

    const merged = await aggregateToolManifests(nodeFs, nodeJoiner, dest);
    expect(merged).not.toBeNull();
    expect(merged!.counts).toEqual({ added: 3, changed: 1, removed: 1, unchanged: 8 });
    expect(merged!.generatedAt).toBe(200);
    expect(merged!.destination).toBe(dest);
  });

  it("concatenates entries and errors from each tool manifest", async () => {
    await writeToolManifest("claude", {
      entries: [
        {
          kind: "artifact",
          tool: "claude",
          scope: "global",
          relPath: "skills/foo.md",
          destPath: "/x/skills/foo.md",
          sha256: "",
          bytes: 10,
          status: "added",
        },
      ],
      errors: ["claude oops"],
    });
    await writeToolManifest("codex", {
      entries: [
        {
          kind: "artifact",
          tool: "codex",
          scope: "global",
          relPath: "memory/AGENTS.md",
          destPath: "/x/memory/AGENTS.md",
          sha256: "",
          bytes: 20,
          status: "added",
        },
      ],
      errors: [],
    });

    const merged = await aggregateToolManifests(nodeFs, nodeJoiner, dest);
    expect(merged!.entries).toHaveLength(2);
    expect(merged!.entries.map((e) => e.relPath).sort()).toEqual([
      "memory/AGENTS.md",
      "skills/foo.md",
    ]);
    expect(merged!.errors).toEqual(["claude oops"]);
  });

  it("never produces tool='master' entries (master folder is browsed live, not via per-tool manifests)", async () => {
    await writeToolManifest("claude", {
      entries: [
        {
          kind: "artifact",
          tool: "claude",
          scope: "global",
          relPath: "skills/foo.md",
          destPath: "/x/skills/foo.md",
          sha256: "",
          bytes: 10,
          status: "added",
        },
      ],
    });

    const merged = await aggregateToolManifests(nodeFs, nodeJoiner, dest);
    const masterEntries = merged!.entries.filter(
      (e) => e.kind === "artifact" && e.tool === ("master" as Tool),
    );
    expect(masterEntries).toEqual([]);
  });
});

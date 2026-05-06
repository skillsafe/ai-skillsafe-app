import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEntry,
  emptyIndex,
  findEntry,
  isDuplicateOfLatest,
  removeEntry,
} from "../src/lib/editHistory/index";
import { HISTORY_CAP } from "../src/lib/editHistory/types";
import { pathKey } from "../src/lib/editHistory/pathKey";
import {
  loadIndex,
  readSnapshot,
  recordSnapshot,
} from "../src/lib/editHistory/store";
import type { HistoryDeps } from "../src/lib/editHistory/store";
import { makeTmp, nodeFs, nodeJoiner, rmrf } from "./_helpers";

describe("editHistory pathKey", () => {
  it("returns the same hash for the same path", async () => {
    const a = await pathKey("/Users/x/file.md");
    const b = await pathKey("/Users/x/file.md");
    expect(a).toBe(b);
  });

  it("returns different hashes for different paths", async () => {
    const a = await pathKey("/Users/x/file.md");
    const b = await pathKey("/Users/x/file2.md");
    expect(a).not.toBe(b);
  });

  it("produces a 64-char hex string", async () => {
    const k = await pathKey("/a/b");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("editHistory index (pure)", () => {
  it("appendEntry produces newest-last ordering", () => {
    let idx = emptyIndex("/p");
    const r1 = appendEntry(idx, { sha256: "a", size: 1, source: "save", ts: 1 });
    const r2 = appendEntry(r1.next, { sha256: "b", size: 2, source: "save", ts: 2 });
    expect(r2.next.entries.map((e) => e.sha256)).toEqual(["a", "b"]);
  });

  it("isDuplicateOfLatest matches only the most recent sha", () => {
    let idx = emptyIndex("/p");
    const r1 = appendEntry(idx, { sha256: "a", size: 1, source: "save", ts: 1 });
    expect(isDuplicateOfLatest(r1.next, "a")).toBe(true);
    expect(isDuplicateOfLatest(r1.next, "b")).toBe(false);
    const r2 = appendEntry(r1.next, { sha256: "b", size: 1, source: "save", ts: 2 });
    expect(isDuplicateOfLatest(r2.next, "a")).toBe(false);
    expect(isDuplicateOfLatest(r2.next, "b")).toBe(true);
  });

  it("appendEntry drops oldest once over the cap and reports them", () => {
    let idx = emptyIndex("/p");
    let dropped: { id: string }[] = [];
    for (let i = 0; i < HISTORY_CAP + 3; i++) {
      const r = appendEntry(idx, {
        sha256: `s-${i}`,
        size: i,
        source: "save",
        ts: i + 1,
      });
      idx = r.next;
      dropped = dropped.concat(r.dropped);
    }
    expect(idx.entries).toHaveLength(HISTORY_CAP);
    expect(dropped).toHaveLength(3);
    expect(idx.entries[0].sha256).toBe(`s-3`);
    expect(idx.entries[idx.entries.length - 1].sha256).toBe(`s-${HISTORY_CAP + 2}`);
  });

  it("findEntry / removeEntry round-trip", () => {
    let idx = emptyIndex("/p");
    const r = appendEntry(idx, { sha256: "x", size: 1, source: "save", ts: 1 });
    const id = r.entry.id;
    expect(findEntry(r.next, id)?.sha256).toBe("x");
    const removed = removeEntry(r.next, id);
    expect(removed.removed?.id).toBe(id);
    expect(findEntry(removed.next, id)).toBeNull();
  });
});

describe("editHistory store (I/O)", () => {
  let tmp: string;
  let deps: HistoryDeps;

  beforeEach(async () => {
    tmp = await makeTmp("edit-history");
    deps = { fs: nodeFs, joiner: nodeJoiner, root: path.join(tmp, "edit-history") };
  });

  afterEach(async () => {
    await rmrf(tmp);
  });

  it("recordSnapshot writes blob + index, then loadIndex reads them back", async () => {
    const target = "/some/abs/file.md";
    const r = await recordSnapshot(deps, target, "hello\n", "save");
    expect(r.deduped).toBe(false);
    expect(r.entry).not.toBeNull();
    const idx = await loadIndex(deps, target);
    expect(idx.entries).toHaveLength(1);
    expect(idx.entries[0].sha256).toBe(r.entry!.sha256);

    const blob = await readSnapshot(deps, target, r.entry!.id);
    expect(blob).toBe("hello\n");
  });

  it("recordSnapshot dedupes consecutive identical content", async () => {
    const target = "/file.md";
    const a = await recordSnapshot(deps, target, "same", "save");
    const b = await recordSnapshot(deps, target, "same", "save");
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.entry).toBeNull();
    const idx = await loadIndex(deps, target);
    expect(idx.entries).toHaveLength(1);
  });

  it("loadIndex returns empty for unseen path", async () => {
    const idx = await loadIndex(deps, "/never/saved.md");
    expect(idx.entries).toHaveLength(0);
    expect(idx.absPath).toBe("/never/saved.md");
  });

  it("over-cap recording deletes oldest blob from disk", async () => {
    const target = "/cap.md";
    const ids: string[] = [];
    for (let i = 0; i < HISTORY_CAP + 1; i++) {
      const r = await recordSnapshot(deps, target, `v-${i}`, "save");
      ids.push(r.entry!.id);
    }
    const idx = await loadIndex(deps, target);
    expect(idx.entries).toHaveLength(HISTORY_CAP);
    // Oldest blob should be gone, newest still readable.
    expect(await readSnapshot(deps, target, ids[0])).toBeNull();
    expect(await readSnapshot(deps, target, ids[ids.length - 1])).toBe(
      `v-${HISTORY_CAP}`,
    );
  });

  it("two different paths get isolated histories", async () => {
    await recordSnapshot(deps, "/a.md", "A", "save");
    await recordSnapshot(deps, "/b.md", "B", "save");
    const a = await loadIndex(deps, "/a.md");
    const b = await loadIndex(deps, "/b.md");
    expect(a.entries).toHaveLength(1);
    expect(b.entries).toHaveLength(1);
    expect(a.entries[0].sha256).not.toBe(b.entries[0].sha256);
  });
});

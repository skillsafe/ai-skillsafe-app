import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTmp, nodeFs, nodeJoiner, rmrf } from "./_helpers";
import {
  resolveRestoreMappings,
  type RestoreMapping,
} from "../src/lib/backup/generateScripts";
import { scanForConflicts } from "../src/lib/backup/restoreScan";
import { applyRestore } from "../src/lib/backup/restoreApply";

let tmp: string;
let backup: string;
let live: string;
let home: string;

async function write(p: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body);
}

async function backupTreeFor(home: string, mirror: string): Promise<RestoreMapping[]> {
  return resolveRestoreMappings({
    fs: nodeFs,
    joiner: nodeJoiner,
    home,
    destination: mirror,
    tools: ["claude"],
    dataTypes: { claude: ["skills"] },
  });
}

beforeEach(async () => {
  tmp = await makeTmp("restore-test");
  backup = path.join(tmp, "mirror");
  live = path.join(tmp, "home");
  home = live;
  // Build a backup layout that matches what the backup script would produce:
  //   <mirror>/claude/skills/<filename>  ← inner "skills" is the rel
  await write(path.join(backup, "claude/skills/foo.md"), "from-backup-foo");
  await write(path.join(backup, "claude/skills/bar.md"), "from-backup-bar");
  await write(path.join(backup, "claude/skills/keep.md"), "shared");
});

afterEach(async () => {
  await rmrf(tmp);
});

describe("restore scan", () => {
  it("flags new + modified files; ignores identical ones", async () => {
    await write(path.join(live, ".claude/skills/keep.md"), "shared");
    await write(path.join(live, ".claude/skills/foo.md"), "different");
    // bar.md missing from live — should be flagged "new".

    // Match mtimes for the "kept" file so the heuristic treats it as identical.
    const stat = await fs.stat(path.join(backup, "claude/skills/keep.md"));
    await fs.utimes(path.join(live, ".claude/skills/keep.md"), stat.atime, stat.mtime);

    const mappings = await backupTreeFor(home, backup);
    const conflicts = await scanForConflicts({
      fs: nodeFs,
      joiner: nodeJoiner,
      mappings,
      mirror: false,
    });
    const byRel = Object.fromEntries(conflicts.map((c) => [c.rel, c.kind]));
    expect(byRel["foo.md"]).toBe("modified");
    expect(byRel["bar.md"]).toBe("new");
    expect(byRel["keep.md"]).toBeUndefined();
  });

  it("emits 'extra' entries only with mirror=true", async () => {
    await write(path.join(live, ".claude/skills/foo.md"), "from-backup-foo");
    await write(path.join(live, ".claude/skills/bar.md"), "from-backup-bar");
    await write(path.join(live, ".claude/skills/keep.md"), "shared");
    await write(path.join(live, ".claude/skills/junk.md"), "user-added-after-backup");
    // Match all mtimes so files compare identical.
    for (const name of ["foo.md", "bar.md", "keep.md"]) {
      const s = await fs.stat(path.join(backup, "claude/skills", name));
      await fs.utimes(path.join(live, ".claude/skills", name), s.atime, s.mtime);
    }
    const mappings = await backupTreeFor(home, backup);
    const overlay = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: false,
    });
    expect(overlay).toHaveLength(0);
    const mirror = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: true,
    });
    expect(mirror).toHaveLength(1);
    expect(mirror[0].kind).toBe("extra");
    expect(mirror[0].rel).toBe("junk.md");
  });

  it("skips files that are byte-identical even when mtimes differ", async () => {
    // Same content, different mtimes — should NOT show up as a conflict.
    await write(path.join(live, ".claude/skills/foo.md"), "from-backup-foo");
    await write(path.join(live, ".claude/skills/bar.md"), "from-backup-bar");
    await write(path.join(live, ".claude/skills/keep.md"), "shared");
    // Force the mtime on the live tree to be 30 days off from the backup.
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    for (const name of ["foo.md", "bar.md", "keep.md"]) {
      await fs.utimes(path.join(live, ".claude/skills", name), past, past);
    }
    const mappings = await backupTreeFor(home, backup);
    const conflicts = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: false,
    });
    expect(conflicts).toEqual([]);
  });

  it("falls back to size-only when content differs at the same byte length", async () => {
    // Same length, different content ⇒ must be flagged as modified.
    await write(path.join(live, ".claude/skills/foo.md"), "FROM-LIVE-FOOOO"); // 15 chars
    expect("from-backup-foo".length).toBe(15);
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await fs.utimes(path.join(live, ".claude/skills/foo.md"), past, past);
    const mappings = await backupTreeFor(home, backup);
    const conflicts = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: false,
    });
    const foo = conflicts.find((c) => c.rel === "foo.md");
    expect(foo?.kind).toBe("modified");
  });

  it("scans single-file mappings (settings data type)", async () => {
    await write(path.join(backup, "claude/settings/settings.json"), '{"version":"backup"}');
    await write(path.join(live, ".claude/settings.json"), '{"x":2}');
    const mappings = await resolveRestoreMappings({
      fs: nodeFs, joiner: nodeJoiner, home, destination: backup,
      tools: ["claude"], dataTypes: { claude: ["settings"] },
    });
    const conflicts = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: false,
    });
    const settingsConflict = conflicts.find((c) => c.rel === "settings.json");
    expect(settingsConflict?.kind).toBe("modified");
    expect(settingsConflict?.dstPath).toBe(path.join(home, ".claude", "settings.json"));
  });
});

describe("restore apply (per-file selection)", () => {
  it("copies only the items handed to it", async () => {
    await write(path.join(live, ".claude/skills/foo.md"), "old-foo");
    await write(path.join(live, ".claude/skills/keep.md"), "shared");
    const mappings = await backupTreeFor(home, backup);
    const conflicts = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: false,
    });
    // User picks only foo.md, deselects bar.md.
    const fooOnly = conflicts.filter((c) => c.rel === "foo.md");
    const result = await applyRestore({ fs: nodeFs, items: fooOnly });
    expect(result.copied).toBe(1);
    expect(result.failed).toEqual([]);
    expect(await fs.readFile(path.join(live, ".claude/skills/foo.md"), "utf8")).toBe(
      "from-backup-foo",
    );
    // bar.md should NOT have been created — user deselected it.
    expect(
      await fs
        .access(path.join(live, ".claude/skills/bar.md"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it("creates parent dirs when restoring to a path that doesn't exist yet", async () => {
    const mappings = await backupTreeFor(home, backup);
    const conflicts = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: false,
    });
    expect(conflicts.length).toBeGreaterThan(0);
    const result = await applyRestore({ fs: nodeFs, items: conflicts });
    expect(result.copied).toBe(conflicts.length);
    expect(result.failed).toEqual([]);
    expect(await fs.readFile(path.join(live, ".claude/skills/foo.md"), "utf8")).toBe(
      "from-backup-foo",
    );
  });

  it("deletes 'extra' items when included in the apply set", async () => {
    await write(path.join(live, ".claude/skills/junk.md"), "delete me");
    const mappings = await backupTreeFor(home, backup);
    const conflicts = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: true,
    });
    const extraOnly = conflicts.filter((c) => c.kind === "extra");
    expect(extraOnly).toHaveLength(1);
    const result = await applyRestore({ fs: nodeFs, items: extraOnly });
    expect(result.deleted).toBe(1);
    expect(
      await fs.access(path.join(live, ".claude/skills/junk.md")).then(() => true).catch(() => false),
    ).toBe(false);
  });

  it("restores stray top-level files in flat-layout tools (e.g. ~/.agents/.skill-lock.json)", async () => {
    // The "shared-agents" extra source mirrors all of ~/.agents/, so
    // .skill-lock.json lives at <dest>/shared-agents/.skill-lock.json. The
    // browser groups it under "Settings" (via the slotForPath fallback),
    // but the restore mapping must still send it back to ~/.agents/, not
    // ~/.agents/settings/.
    await write(
      path.join(backup, "shared-agents/.skill-lock.json"),
      '{"version":3,"skills":{}}',
    );
    const mappings = await resolveRestoreMappings({
      fs: nodeFs,
      joiner: nodeJoiner,
      home,
      destination: backup,
      tools: ["shared-agents"],
      dataTypes: { "shared-agents": ["all"] },
    });
    const conflicts = await scanForConflicts({
      fs: nodeFs,
      joiner: nodeJoiner,
      mappings,
      mirror: false,
    });
    const lock = conflicts.find((c) => c.rel === ".skill-lock.json");
    expect(lock).toBeDefined();
    expect(lock!.dstPath).toBe(path.join(home, ".agents", ".skill-lock.json"));
    expect(lock!.kind).toBe("new");
    const result = await applyRestore({ fs: nodeFs, items: [lock!] });
    expect(result.copied).toBe(1);
    expect(
      await fs.readFile(path.join(home, ".agents/.skill-lock.json"), "utf8"),
    ).toBe('{"version":3,"skills":{}}');
  });

  it("reports per-item failures without aborting the rest", async () => {
    const mappings = await backupTreeFor(home, backup);
    const conflicts = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: false,
    });
    // Sabotage one item with a bogus src so the read fails.
    const broken = { ...conflicts[0], srcPath: "/nonexistent/path-that-cannot-exist" };
    const items = [broken, ...conflicts.slice(1)];
    const result = await applyRestore({ fs: nodeFs, items });
    expect(result.copied).toBe(items.length - 1);
    expect(result.failed).toHaveLength(1);
  });

  it("emits onProgress for each item", async () => {
    const mappings = await backupTreeFor(home, backup);
    const conflicts = await scanForConflicts({
      fs: nodeFs, joiner: nodeJoiner, mappings, mirror: false,
    });
    const seen: number[] = [];
    await applyRestore({
      fs: nodeFs,
      items: conflicts,
      onProgress: (done) => { seen.push(done); },
    });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(conflicts.length);
  });
});

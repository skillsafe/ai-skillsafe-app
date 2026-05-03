import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBackup } from "../src/lib/backup/runBackup";
import { generateScripts } from "../src/lib/backup/generateScripts";
import { MANIFEST_FILENAME, parseManifest, summarize } from "../src/lib/backup/manifest";
import type { FsAdapter } from "../src/lib/fs";
import { resetHomeCache } from "../src/lib/paths";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

describe("runBackup", () => {
  let tmp: string;
  let home: string;
  let dest: string;

  beforeEach(async () => {
    resetHomeCache();
    tmp = await makeTmp("backup");
    home = path.join(tmp, "home");
    dest = path.join(tmp, "drive");
    // Seed a minimal ~/.claude/skills/foo bundle.
    await fs.mkdir(path.join(home, ".claude", "skills", "foo"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude", "skills", "foo", "SKILL.md"),
      "---\nname: foo\n---\nbody\n",
    );
    await fs.writeFile(
      path.join(home, ".claude", "skills", "foo", "asset.bin"),
      Buffer.from([1, 2, 3, 4]),
    );
    // Seed a project history dir.
    await fs.mkdir(path.join(home, ".claude", "projects", "proj-1"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude", "projects", "proj-1", "MEMORY.md"),
      "# memory\n",
    );
    // Seed an excluded cache dir to verify it is dropped.
    await fs.mkdir(path.join(home, ".claude", "cache"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "cache", "junk"), "skip me");
    await fs.mkdir(dest, { recursive: true });
  });

  afterEach(async () => {
    await rmrf(tmp);
  });

  it("mirrors artifacts and ~/.claude/projects on first run", async () => {
    const m = await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });

    const root = dest;
    expect(
      await fs.readFile(path.join(root, "claude_backup", "global", "skill", "foo", "SKILL.md"), "utf8"),
    ).toContain("name: foo");
    const asset = await fs.readFile(path.join(root, "claude_backup", "global", "skill", "foo", "asset.bin"));
    expect(asset).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(await fs.readFile(path.join(root, "claude_backup", "history", "proj-1", "MEMORY.md"), "utf8")).toBe(
      "# memory\n",
    );
    expect(m.counts.added).toBeGreaterThan(0);
    expect(m.counts.changed).toBe(0);
    expect(m.errors).toEqual([]);

    // Excluded cache dir must NOT be mirrored. (It lives under the artifact
    // skills dir's parent, so confirm it didn't sneak in via history.)
    const historyContents = await fs.readdir(path.join(root, "claude_backup", "history"));
    expect(historyContents).not.toContain("cache");
    // Manifest now lives inside the per-tool subdir.
    const manifestText = await fs.readFile(
      path.join(root, "claude_backup", MANIFEST_FILENAME),
      "utf8",
    );
    const manifest = parseManifest(manifestText);
    expect(manifest?.entries.length).toBe(m.entries.length);
  });

  it("re-runs without changes are a no-op write-wise", async () => {
    await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });

    let writes = 0;
    const counting: FsAdapter = {
      ...nodeFs,
      writeFile: async (p, c) => {
        writes += 1;
        return nodeFs.writeFile!(p, c);
      },
      writeTextFile: async (p, c) => {
        // Manifest goes through writeTextFile via atomicWrite; don't count it.
        return nodeFs.writeTextFile(p, c);
      },
    };

    const m2 = await runBackup({
      fs: counting,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });

    expect(writes).toBe(0);
    expect(m2.counts.changed).toBe(0);
    expect(m2.counts.added).toBe(0);
    expect(m2.counts.unchanged).toBeGreaterThan(0);
  });

  it("rewrites only the modified file", async () => {
    await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });

    await fs.writeFile(
      path.join(home, ".claude", "skills", "foo", "SKILL.md"),
      "---\nname: foo\n---\nbody v2\n",
    );

    const m = await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });

    expect(m.counts.changed).toBe(1);
    expect(m.counts.added).toBe(0);
    expect(
      await fs.readFile(
        path.join(dest, "claude_backup", "global", "skill", "foo", "SKILL.md"),
        "utf8",
      ),
    ).toContain("body v2");
  });

  it("removes destination entries when source files are deleted", async () => {
    await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });

    await fs.rm(path.join(home, ".claude", "skills", "foo", "asset.bin"));

    const m = await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });

    expect(m.counts.removed).toBe(1);
    const stillExists = await fs
      .access(path.join(dest, "claude_backup", "global", "skill", "foo", "asset.bin"))
      .then(() => true)
      .catch(() => false);
    expect(stillExists).toBe(false);
  });

  it("summarize() exposes recentChanges with destPath and status", async () => {
    const m1 = await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });
    const stats1 = summarize(m1);
    expect(stats1.recentChanges.length).toBeGreaterThan(0);
    expect(stats1.recentChanges[0].status).toBe("added");
    expect(stats1.recentChanges[0].destPath).toContain(dest);
    expect(stats1.backupRoot).toBe(dest);

    // No changes on second run → no recent changes.
    const m2 = await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });
    expect(summarize(m2).recentChanges).toEqual([]);

    // Modify one file → exactly one "changed" entry surfaces.
    await fs.writeFile(
      path.join(home, ".claude", "skills", "foo", "SKILL.md"),
      "---\nname: foo\n---\nv3\n",
    );
    const m3 = await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });
    const stats3 = summarize(m3);
    expect(stats3.recentChanges.length).toBe(1);
    expect(stats3.recentChanges[0].status).toBe("changed");
    expect(stats3.recentChanges[0].relPath).toContain("SKILL.md");
  });

  it("never touches files outside the skillsafe-backup subdirectory", async () => {
    const sibling = path.join(dest, "user-other-file.txt");
    await fs.writeFile(sibling, "DO NOT TOUCH");
    await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });
    expect(await fs.readFile(sibling, "utf8")).toBe("DO NOT TOUCH");
  });
});

describe("generateScripts", () => {
  let tmp: string;
  let dest: string;
  let outDir: string;

  beforeEach(async () => {
    tmp = await makeTmp("scripts");
    dest = path.join(tmp, "drive", "skillsafe-backup");
    outDir = path.join(tmp, "drive", "scheduled-backup");
  });

  afterEach(async () => {
    await rmrf(tmp);
  });

  it("emits mac script + plist + readme with no leftover placeholders", async () => {
    const result = await generateScripts({
      fs: nodeFs,
      joiner: nodeJoiner,
      platform: "macos",
      home: "/Users/test",
      destination: dest,
      outDir,
    });

    expect(result.files.length).toBe(3);
    for (const f of result.files) {
      const text = await fs.readFile(f.path, "utf8");
      expect(text).not.toMatch(/{{[A-Z_]+}}/);
    }
    const sh = await fs.readFile(path.join(outDir, "claude_backup.sh"), "utf8");
    expect(sh).toContain("/Users/test/.claude/");
    expect(sh).toContain(dest);
  });

  it("emits windows script + register-task + readme with no leftover placeholders", async () => {
    const result = await generateScripts({
      fs: nodeFs,
      joiner: nodeJoiner,
      platform: "windows",
      home: "C:\\Users\\Test",
      destination: dest,
      outDir,
    });

    expect(result.files.length).toBe(3);
    for (const f of result.files) {
      const text = await fs.readFile(f.path, "utf8");
      expect(text).not.toMatch(/{{[A-Z_]+}}/);
    }
    const ps1 = await fs.readFile(path.join(outDir, "claude_backup.ps1"), "utf8");
    expect(ps1).toContain("C:\\Users\\Test\\.claude");
    const reg = await fs.readFile(path.join(outDir, "register-task.ps1"), "utf8");
    expect(reg).toContain(path.join(outDir, "claude_backup.ps1"));
  });
});

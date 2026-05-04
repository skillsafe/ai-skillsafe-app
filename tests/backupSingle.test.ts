import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupOneArtifact, restoreFromBackup } from "../src/lib/backup/single";
import { loadSkillBundle } from "../src/lib/artifacts/skill";
import { MANIFEST_FILENAME, parseManifest } from "../src/lib/backup/manifest";
import { resetHomeCache } from "../src/lib/paths";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

describe("backupOneArtifact", () => {
  let tmp: string;
  let home: string;
  let dest: string;

  beforeEach(async () => {
    resetHomeCache();
    tmp = await makeTmp("backup-single");
    home = path.join(tmp, "home");
    dest = path.join(tmp, "drive");
    await fs.mkdir(path.join(home, ".claude", "skills", "foo"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude", "skills", "foo", "SKILL.md"),
      "---\nname: foo\n---\nbody\n",
    );
    await fs.writeFile(
      path.join(home, ".claude", "skills", "foo", "asset.bin"),
      Buffer.from([1, 2, 3, 4]),
    );
    // A second skill that should NOT be backed up by single-artifact run.
    await fs.mkdir(path.join(home, ".claude", "skills", "bar"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude", "skills", "bar", "SKILL.md"),
      "---\nname: bar\n---\nbar body\n",
    );
    await fs.mkdir(dest, { recursive: true });
  });

  afterEach(async () => {
    await rmrf(tmp);
  });

  it("mirrors only the chosen bundle and writes a manifest", async () => {
    const artifact = await loadSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".claude", "skills", "foo"),
      "claude",
      "global",
    );
    const stats = await backupOneArtifact({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      artifact,
    });

    expect(
      await fs.readFile(path.join(dest, "claude_backup", "global", "skill", "foo", "SKILL.md"), "utf8"),
    ).toContain("name: foo");
    expect(
      await fs.readFile(path.join(dest, "claude_backup", "global", "skill", "foo", "asset.bin")),
    ).toEqual(Buffer.from([1, 2, 3, 4]));
    // The unrelated "bar" bundle must not have been touched.
    const skillDir = await fs.readdir(path.join(dest, "claude_backup", "global", "skill"));
    expect(skillDir).toEqual(["foo"]);

    const manifestText = await fs.readFile(
      path.join(dest, "claude_backup", MANIFEST_FILENAME),
      "utf8",
    );
    const manifest = parseManifest(manifestText);
    expect(manifest).not.toBeNull();
    expect(manifest!.entries.every((e) => e.relPath.startsWith("artifacts/claude/global/skill/foo/"))).toBe(true);
    expect(stats.counts.added).toBeGreaterThan(0);
  });

  it("merges into an existing manifest without duplicating entries", async () => {
    const fooArtifact = await loadSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".claude", "skills", "foo"),
      "claude",
      "global",
    );
    await backupOneArtifact({
      fs: nodeFs, paths: pathDeps(home), joiner: nodeJoiner,
      destination: dest, artifact: fooArtifact,
    });
    // Re-run for the same artifact — entries should replace, not duplicate.
    await backupOneArtifact({
      fs: nodeFs, paths: pathDeps(home), joiner: nodeJoiner,
      destination: dest, artifact: fooArtifact,
    });
    const manifest = parseManifest(
      await fs.readFile(path.join(dest, "claude_backup", MANIFEST_FILENAME), "utf8"),
    )!;
    const fooEntries = manifest.entries.filter((e) =>
      e.relPath.startsWith("artifacts/claude/global/skill/foo/"),
    );
    // 2 source files (SKILL.md + asset.bin) → exactly 2 entries, not 4.
    expect(fooEntries.length).toBe(2);
  });

  it("returns this-run counts on a no-op rerun (added=0, unchanged=N)", async () => {
    const fooArtifact = await loadSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".claude", "skills", "foo"),
      "claude",
      "global",
    );
    const first = await backupOneArtifact({
      fs: nodeFs, paths: pathDeps(home), joiner: nodeJoiner,
      destination: dest, artifact: fooArtifact,
    });
    expect(first.counts.added).toBe(2);
    expect(first.counts.unchanged).toBe(0);
    expect(first.recentChanges.length).toBe(2);

    // Source unchanged, second run should see all files as unchanged.
    const second = await backupOneArtifact({
      fs: nodeFs, paths: pathDeps(home), joiner: nodeJoiner,
      destination: dest, artifact: fooArtifact,
    });
    // counts.added must NOT keep growing on no-op reruns (the bug we're guarding).
    expect(second.counts.added).toBe(0);
    expect(second.counts.changed).toBe(0);
    expect(second.counts.unchanged).toBe(2);
    expect(second.recentChanges.length).toBe(0);

    // The persisted manifest's counts should reflect the entry statuses,
    // not the lifetime sum of every prior run.
    const manifest = parseManifest(
      await fs.readFile(path.join(dest, "claude_backup", MANIFEST_FILENAME), "utf8"),
    )!;
    expect(manifest.counts.added).toBe(0);
    expect(manifest.counts.unchanged).toBe(2);
  });
});

describe("restoreFromBackup", () => {
  let tmp: string;
  let home: string;
  let dest: string;

  beforeEach(async () => {
    resetHomeCache();
    tmp = await makeTmp("restore");
    home = path.join(tmp, "home");
    dest = path.join(tmp, "drive");
    await fs.mkdir(path.join(home, ".claude", "skills", "foo"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude", "skills", "foo", "SKILL.md"),
      "---\nname: foo\n---\nbody\n",
    );
    await fs.writeFile(
      path.join(home, ".claude", "skills", "foo", "asset.bin"),
      Buffer.from([1, 2, 3, 4]),
    );
    await fs.mkdir(dest, { recursive: true });
  });

  afterEach(async () => {
    await rmrf(tmp);
  });

  it("round-trips: backup → delete source → restore", async () => {
    const artifact = await loadSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".claude", "skills", "foo"),
      "claude",
      "global",
    );
    await backupOneArtifact({
      fs: nodeFs, paths: pathDeps(home), joiner: nodeJoiner,
      destination: dest, artifact,
    });

    // Wipe the source bundle.
    await fs.rm(path.join(home, ".claude", "skills", "foo"), { recursive: true });

    const result = await restoreFromBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      tool: "claude",
      scope: "global",
      type: "skill",
      bundleName: "foo",
      files: [
        {
          source: path.join(dest, "claude_backup", "global", "skill", "foo", "SKILL.md"),
          relInItem: "SKILL.md",
        },
        {
          source: path.join(dest, "claude_backup", "global", "skill", "foo", "asset.bin"),
          relInItem: "asset.bin",
        },
      ],
    });
    expect(result.written.length).toBe(2);

    expect(
      await fs.readFile(path.join(home, ".claude", "skills", "foo", "SKILL.md"), "utf8"),
    ).toContain("name: foo");
    expect(
      await fs.readFile(path.join(home, ".claude", "skills", "foo", "asset.bin")),
    ).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects path traversal in relInItem", async () => {
    await expect(
      restoreFromBackup({
        fs: nodeFs,
        paths: pathDeps(home),
        joiner: nodeJoiner,
        tool: "claude",
        scope: "global",
        type: "skill",
        bundleName: "foo",
        files: [{ source: path.join(dest, "x"), relInItem: "../escape.md" }],
      }),
    ).rejects.toThrow(/unsafe restore path/);
  });
});

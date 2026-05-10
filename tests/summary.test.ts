import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTmp, nodeFs, nodeJoiner, rmrf } from "./_helpers";
import { buildAndWriteManifest } from "../src/lib/backup/summary";
import { MANIFEST_FILENAME } from "../src/lib/backup/manifest";

let tmp: string;

beforeEach(async () => {
  tmp = await makeTmp("summary-test");
});

afterEach(async () => {
  await rmrf(tmp);
});

async function write(p: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body);
}

describe("backup summary", () => {
  it("counts every file as added on the first run and writes the manifest", async () => {
    await write(path.join(tmp, "claude/skills/foo.md"), "hello");
    await write(path.join(tmp, "claude/skills/bar.md"), "world");
    await write(path.join(tmp, "shared-agents/agents/x.md"), "shared");

    const { manifest, stats } = await buildAndWriteManifest({
      fs: nodeFs,
      joiner: nodeJoiner,
      destination: tmp,
      generatedAt: 1234,
    });

    expect(stats.counts.added).toBe(3);
    expect(stats.counts.changed).toBe(0);
    expect(stats.counts.removed).toBe(0);
    expect(stats.totalBytes).toBe("hello".length + "world".length + "shared".length);
    expect(manifest.entries.map((e) => e.relPath).sort()).toEqual([
      "claude/skills/bar.md",
      "claude/skills/foo.md",
      "shared-agents/agents/x.md",
    ]);
    // Manifest persisted at the dest root.
    const manifestPath = path.join(tmp, MANIFEST_FILENAME);
    expect(await fs.readFile(manifestPath, "utf8")).toContain("claude/skills/foo.md");
  });

  it("computes added/changed/removed against a prior manifest", async () => {
    // First run.
    await write(path.join(tmp, "a.md"), "first");
    await write(path.join(tmp, "b.md"), "second");
    await buildAndWriteManifest({
      fs: nodeFs,
      joiner: nodeJoiner,
      destination: tmp,
      generatedAt: 1,
    });

    // Mutate: edit a.md, delete b.md, add c.md.
    await fs.writeFile(path.join(tmp, "a.md"), "first-edited");
    await fs.unlink(path.join(tmp, "b.md"));
    await write(path.join(tmp, "c.md"), "third");

    const { stats } = await buildAndWriteManifest({
      fs: nodeFs,
      joiner: nodeJoiner,
      destination: tmp,
      generatedAt: 2,
    });

    expect(stats.counts.added).toBe(1);
    expect(stats.counts.changed).toBe(1);
    expect(stats.counts.removed).toBe(1);
    expect(stats.recentChanges.map((c) => c.relPath).sort()).toEqual(["a.md", "c.md"]);
  });

  it("buckets stray top-level files in flat-layout tools under 'settings'", async () => {
    // ~/.agents/.skill-lock.json comes through as
    // shared-agents/.skill-lock.json — parts[1] is the filename, not a
    // known data-type slot, so slotForPath should fall back to "settings".
    await write(path.join(tmp, "shared-agents/.skill-lock.json"), "{}");
    await write(path.join(tmp, "shared-agents/skills/foo/SKILL.md"), "skill");
    const { manifest } = await buildAndWriteManifest({
      fs: nodeFs, joiner: nodeJoiner, destination: tmp, generatedAt: 1,
    });
    const lock = manifest.entries.find((e) => e.relPath === "shared-agents/.skill-lock.json");
    const skill = manifest.entries.find((e) => e.relPath === "shared-agents/skills/foo/SKILL.md");
    expect(lock?.tool).toBe("shared-agents");
    // type is the legacy artifact-type field — undefined for "settings"
    // because Settings doesn't map to skill/agent/command.
    expect(lock?.type).toBeUndefined();
    expect(skill?.type).toBe("skill");
  });

  it("infers tool/scope/type from the relPath so the BackupBrowser can group entries", async () => {
    await write(path.join(tmp, "claude/skills/html2docx/SKILL.md"), "skill");
    await write(path.join(tmp, "claude/agents/x.md"), "agent");
    await write(path.join(tmp, "claude/commands/y.md"), "command");
    await write(path.join(tmp, "claude/memory/projects/z.json"), "memory");
    await write(path.join(tmp, "shared-agents/skills/foo/SKILL.md"), "shared-skill");

    const { manifest } = await buildAndWriteManifest({
      fs: nodeFs,
      joiner: nodeJoiner,
      destination: tmp,
      generatedAt: 1,
    });

    const byPath = Object.fromEntries(manifest.entries.map((e) => [e.relPath, e]));
    expect(byPath["claude/skills/html2docx/SKILL.md"].tool).toBe("claude");
    expect(byPath["claude/skills/html2docx/SKILL.md"].type).toBe("skill");
    expect(byPath["claude/skills/html2docx/SKILL.md"].scope).toBe("global");
    expect(byPath["claude/agents/x.md"].type).toBe("agent");
    expect(byPath["claude/commands/y.md"].type).toBe("command");
    // Unknown slot — entry still tracked, just not grouped under a type filter.
    expect(byPath["claude/memory/projects/z.json"].tool).toBe("claude");
    expect(byPath["claude/memory/projects/z.json"].type).toBeUndefined();
    expect(byPath["shared-agents/skills/foo/SKILL.md"].tool).toBe("shared-agents");
    expect(byPath["shared-agents/skills/foo/SKILL.md"].type).toBe("skill");
  });

  it("skips its own LAST_BACKUP.json so the manifest doesn't ingest itself", async () => {
    await write(path.join(tmp, "a.md"), "x");
    await buildAndWriteManifest({
      fs: nodeFs,
      joiner: nodeJoiner,
      destination: tmp,
      generatedAt: 1,
    });
    // Run again — LAST_BACKUP.json now exists, but should not show up as an
    // entry on the second run.
    const { manifest } = await buildAndWriteManifest({
      fs: nodeFs,
      joiner: nodeJoiner,
      destination: tmp,
      generatedAt: 2,
    });
    expect(manifest.entries.map((e) => e.relPath)).not.toContain(MANIFEST_FILENAME);
  });

  it("skips the master/ subtree so curated files never appear as backup rows", async () => {
    // Regular tool files at the root — should appear.
    await write(path.join(tmp, "claude/skills/foo.md"), "hello");
    // Master folder content — should NOT appear; it's browsed live by
    // loadMasterAsBackupEntries instead.
    await write(path.join(tmp, "master/manifest.json"), "{}");
    await write(path.join(tmp, "master/memory/global/claude/CLAUDE.md"), "x");
    await write(path.join(tmp, "master/permissions/global/claude/permissions.json"), "{}");

    const { manifest } = await buildAndWriteManifest({
      fs: nodeFs,
      joiner: nodeJoiner,
      destination: tmp,
      generatedAt: 1,
    });

    const paths = manifest.entries.map((e) => e.relPath);
    expect(paths).toContain("claude/skills/foo.md");
    expect(paths.some((p) => p.startsWith("master/"))).toBe(false);
  });
});

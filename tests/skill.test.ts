import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillBundle,
  deleteSkillBundle,
  listSkillBundles,
  loadSkillBundle,
  saveSkillBundle,
} from "../src/lib/artifacts/skill";
import { makeTmp, nodeFs, nodeJoiner, rmrf } from "./_helpers";

describe("skill bundle", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("skill");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("creates, reads, and saves a SKILL.md bundle", async () => {
    const created = await createSkillBundle(
      nodeFs,
      nodeJoiner,
      tmp,
      "demo",
      "A demo skill",
      "claude",
      "global",
    );
    expect(created.frontmatter.name).toBe("demo");
    expect(created.frontmatter.description).toBe("A demo skill");
    const dir = path.join(tmp, "demo");
    const file = path.join(dir, "SKILL.md");
    expect(await fs.readFile(file, "utf8")).toContain("A demo skill");

    const reloaded = await loadSkillBundle(nodeFs, nodeJoiner, dir, "claude", "global");
    expect(reloaded.name).toBe("demo");

    const updated = { ...reloaded, body: "## Updated\n" };
    const saved = await saveSkillBundle(nodeFs, nodeJoiner, updated);
    expect(saved.body.trim()).toBe("## Updated");
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toContain("## Updated");
  });

  it("lists multiple bundles in a directory", async () => {
    await createSkillBundle(nodeFs, nodeJoiner, tmp, "a", "first", "claude", "global");
    await createSkillBundle(nodeFs, nodeJoiner, tmp, "b", "second", "claude", "global");
    await fs.mkdir(path.join(tmp, "no-skill-md"));
    const list = await listSkillBundles(nodeFs, nodeJoiner, tmp, "claude", "global");
    expect(list.map((a) => a.name).sort()).toEqual(["a", "b"]);
  });

  it("captures attachments alongside SKILL.md", async () => {
    const created = await createSkillBundle(
      nodeFs,
      nodeJoiner,
      tmp,
      "withfiles",
      "x",
      "claude",
      "global",
    );
    const bundleDir = created.bundleDir!;
    await fs.writeFile(path.join(bundleDir, "extra.md"), "# extra\n");
    await fs.mkdir(path.join(bundleDir, "scripts"));
    const reloaded = await loadSkillBundle(nodeFs, nodeJoiner, bundleDir, "claude", "global");
    const names = reloaded.attachments.map((a) => a.name).sort();
    expect(names).toContain("extra.md");
    expect(names).toContain("scripts");
  });

  it("deletes a bundle directory", async () => {
    const created = await createSkillBundle(
      nodeFs,
      nodeJoiner,
      tmp,
      "doomed",
      "x",
      "claude",
      "global",
    );
    await deleteSkillBundle(nodeFs, created);
    expect(await nodeFs.exists(created.bundleDir!)).toBe(false);
  });
});

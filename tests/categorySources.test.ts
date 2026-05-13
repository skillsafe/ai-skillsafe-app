import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  buildCategoryTree,
  resolveCategoryRoots,
} from "../src/lib/category/sources";
import { dataTypesFor } from "../src/lib/backup/dataTypes";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

describe("category sources", () => {
  let tmp = "";
  beforeAll(async () => {
    tmp = await makeTmp("category-sources");
    const claude = path.join(tmp, ".claude");
    await fs.mkdir(path.join(claude, "skills", ".system", "shipped"), { recursive: true });
    await fs.writeFile(path.join(claude, "skills", ".system", "shipped", "SKILL.md"), "system");
    await fs.mkdir(path.join(claude, "skills", "user-skill"), { recursive: true });
    await fs.writeFile(path.join(claude, "skills", "user-skill", "SKILL.md"), "user");
    await fs.mkdir(path.join(claude, "projects", "proj-1", "cache"), { recursive: true });
    await fs.writeFile(path.join(claude, "projects", "proj-1", "cache", "junk.bin"), "junk");
    await fs.writeFile(path.join(claude, "projects", "proj-1", "transcript.jsonl"), '{"a":1}\n');
    await fs.writeFile(path.join(claude, "projects", "proj-1", ".DS_Store"), "ds");
    await fs.writeFile(path.join(claude, "settings.json"), "{}");
    await fs.writeFile(path.join(claude, "CLAUDE.md"), "# memory");
    // Codex config files
    const codex = path.join(tmp, ".codex");
    await fs.mkdir(codex, { recursive: true });
    await fs.writeFile(path.join(codex, "config.toml"), "[ui]\n");
    await fs.writeFile(path.join(codex, "auth.json"), "{}");
  });

  afterAll(async () => {
    if (tmp) await rmrf(tmp);
  });

  it("flattens Claude memory roots to per-project entries", async () => {
    // We seeded a single project dir (proj-1) under ~/.claude/projects/.
    // resolveCategoryRoots should skip the `projects/` wrapper and surface
    // proj-1 directly so the UI can stream it in independently rather than
    // waiting for the whole tree to finish.
    const deps = pathDeps(tmp);
    const memory = dataTypesFor("claude").find((d) => d.id === "memory")!;
    const roots = await resolveCategoryRoots(nodeFs, "claude", memory, deps, nodeJoiner);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.name).toBe("proj-1");
    expect(roots[0]?.path.endsWith(path.join("projects", "proj-1"))).toBe(true);
    expect(roots[0]?.isFile).toBe(false);
  });

  it("returns [] when a memory dir is missing", async () => {
    const otherHome = await makeTmp("empty-home");
    try {
      const deps = pathDeps(otherHome);
      const memory = dataTypesFor("claude").find((d) => d.id === "memory")!;
      const roots = await resolveCategoryRoots(nodeFs, "claude", memory, deps, nodeJoiner);
      expect(roots).toEqual([]);
    } finally {
      await rmrf(otherHome);
    }
  });

  it("resolves Claude settings as multiple files (kind:files)", async () => {
    const deps = pathDeps(tmp);
    const settings = dataTypesFor("claude").find((d) => d.id === "settings")!;
    const roots = await resolveCategoryRoots(nodeFs, "claude", settings, deps, nodeJoiner);
    // Only the two files we created (settings.json + CLAUDE.md); .mcp.json and
    // statusline-command.sh don't exist so they're omitted.
    const names = roots.map((r) => r.name).sort();
    expect(names).toEqual(["CLAUDE.md", "settings.json"]);
    for (const r of roots) expect(r.isFile).toBe(true);
  });

  it("resolves Codex config to its two files", async () => {
    const deps = pathDeps(tmp);
    const config = dataTypesFor("codex").find((d) => d.id === "config")!;
    const roots = await resolveCategoryRoots(nodeFs, "codex", config, deps, nodeJoiner);
    expect(roots.map((r) => r.name).sort()).toEqual(["auth.json", "config.toml"]);
  });

  it("builds a category tree and excludes cache/DS_Store noise", async () => {
    const deps = pathDeps(tmp);
    const memory = dataTypesFor("claude").find((d) => d.id === "memory")!;
    const roots = await resolveCategoryRoots(nodeFs, "claude", memory, deps, nodeJoiner);
    const tree = await buildCategoryTree(nodeFs, nodeJoiner, roots, memory.id);
    // Flattened: proj-1 is now a top-level root, not a child of `projects`.
    expect(tree).toHaveLength(1);
    const proj1 = tree[0]!;
    expect(proj1.name).toBe("proj-1");
    expect(proj1.isDir).toBe(true);
    // No `cache` dir, no `.DS_Store`; just the transcript file.
    const kids = proj1.children!;
    expect(kids.map((k) => k.name)).toEqual(["transcript.jsonl"]);
  });

  it("excludes .system top-level dirs for the skills slot only", async () => {
    const deps = pathDeps(tmp);
    const skills = dataTypesFor("claude").find((d) => d.id === "skills")!;
    const roots = await resolveCategoryRoots(nodeFs, "claude", skills, deps, nodeJoiner);
    const tree = await buildCategoryTree(nodeFs, nodeJoiner, roots, skills.id);
    const skillsRoot = tree[0]!;
    const topLevel = skillsRoot.children?.map((c) => c.name);
    expect(topLevel).toEqual(["user-skill"]); // .system filtered out
  });

  it("does NOT exclude .system when a non-skills slot is walked", async () => {
    // Synthesise a fake "memory-like" tree that contains a .system dir to
    // prove the dot-prefix filter is skill-only and not applied universally.
    const fakeRoot = path.join(tmp, "fake-cat");
    await fs.mkdir(path.join(fakeRoot, ".system"), { recursive: true });
    await fs.writeFile(path.join(fakeRoot, ".system", "x.txt"), "x");
    await fs.writeFile(path.join(fakeRoot, "regular.txt"), "r");
    const tree = await buildCategoryTree(
      nodeFs,
      nodeJoiner,
      [{ name: "fake-cat", path: fakeRoot, isFile: false }],
      "memory",
    );
    const names = tree[0]!.children!.map((c) => c.name).sort();
    expect(names).toEqual([".system", "regular.txt"]);
  });
});

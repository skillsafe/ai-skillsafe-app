import { describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { walkMemorySources } from "../src/lib/memory/walker";
import { mergeMemory } from "../src/lib/memory/merge";
import { makeTmp, nodeFs, nodeJoiner, rmrf } from "./_helpers";

describe("memory walker", () => {
  it("collects CLAUDE.md from start dir + ancestor", async () => {
    const tmp = await makeTmp("mem-walk");
    try {
      const project = path.join(tmp, "monorepo", "service-a");
      await fsp.mkdir(project, { recursive: true });
      // No .git anywhere — should walk freely up.
      await fsp.writeFile(path.join(project, "CLAUDE.md"), "service rule\n");
      await fsp.writeFile(path.join(tmp, "monorepo", "CLAUDE.md"), "monorepo rule\n");
      const sources = await walkMemorySources(nodeFs, nodeJoiner, {
        startDir: project,
        homeDir: null,
        maxDepth: 3,
      });
      const paths = sources.map((s) => s.path);
      expect(paths.some((p) => p.endsWith("service-a/CLAUDE.md"))).toBe(true);
      expect(paths.some((p) => p.endsWith("monorepo/CLAUDE.md"))).toBe(true);
    } finally {
      await rmrf(tmp);
    }
  });

  it("stops at .git boundary in parent", async () => {
    const tmp = await makeTmp("mem-walk-git");
    try {
      const outer = path.join(tmp, "outer");
      const inner = path.join(outer, "inner");
      await fsp.mkdir(inner, { recursive: true });
      // Outer is a different repo (its own .git). Inner has none → walking
      // out of inner into outer crosses a boundary → stop.
      await fsp.mkdir(path.join(outer, ".git"));
      await fsp.writeFile(path.join(outer, "CLAUDE.md"), "outer rule\n");
      await fsp.writeFile(path.join(inner, "CLAUDE.md"), "inner rule\n");
      const sources = await walkMemorySources(nodeFs, nodeJoiner, {
        startDir: inner,
        homeDir: null,
        maxDepth: 5,
      });
      const paths = sources.map((s) => s.path);
      expect(paths.some((p) => p.endsWith("inner/CLAUDE.md"))).toBe(true);
      expect(paths.some((p) => p.endsWith("outer/CLAUDE.md"))).toBe(false);
    } finally {
      await rmrf(tmp);
    }
  });

  it("collects global ~/.claude/CLAUDE.md when homeDir is set", async () => {
    const tmp = await makeTmp("mem-walk-home");
    try {
      const home = path.join(tmp, "home");
      const project = path.join(tmp, "proj");
      await fsp.mkdir(path.join(home, ".claude"), { recursive: true });
      await fsp.mkdir(project, { recursive: true });
      await fsp.writeFile(path.join(home, ".claude", "CLAUDE.md"), "global rule\n");
      await fsp.writeFile(path.join(project, "CLAUDE.md"), "project rule\n");
      const sources = await walkMemorySources(nodeFs, nodeJoiner, {
        startDir: project,
        homeDir: home,
        maxDepth: 1,
      });
      expect(sources.some((s) => s.scope === "global")).toBe(true);
      expect(sources.some((s) => s.scope === "project")).toBe(true);
    } finally {
      await rmrf(tmp);
    }
  });

  it("respects maxDepth cap", async () => {
    const tmp = await makeTmp("mem-walk-depth");
    try {
      const deep = path.join(tmp, "a", "b", "c", "d");
      await fsp.mkdir(deep, { recursive: true });
      await fsp.writeFile(path.join(tmp, "CLAUDE.md"), "topmost\n");
      await fsp.writeFile(path.join(deep, "CLAUDE.md"), "deepest\n");
      const sources = await walkMemorySources(nodeFs, nodeJoiner, {
        startDir: deep,
        homeDir: null,
        maxDepth: 1,
      });
      const paths = sources.map((s) => s.path);
      expect(paths.some((p) => p.endsWith("/d/CLAUDE.md"))).toBe(true);
      // tmp/CLAUDE.md is 4 levels up → past the cap.
      expect(paths.some((p) => p === path.join(tmp, "CLAUDE.md"))).toBe(false);
    } finally {
      await rmrf(tmp);
    }
  });

  it("recognizes multiple tool memory files", async () => {
    const tmp = await makeTmp("mem-walk-tools");
    try {
      await fsp.writeFile(path.join(tmp, "CLAUDE.md"), "c\n");
      await fsp.writeFile(path.join(tmp, "AGENTS.md"), "a\n");
      await fsp.writeFile(path.join(tmp, ".cursorrules"), "cr\n");
      const sources = await walkMemorySources(nodeFs, nodeJoiner, {
        startDir: tmp,
        homeDir: null,
        maxDepth: 0,
      });
      const tools = sources.map((s) => s.tool).sort();
      expect(tools).toEqual(["claude", "codex", "cursor"]);
    } finally {
      await rmrf(tmp);
    }
  });
});

describe("mergeMemory", () => {
  it("orders global → project → ancestors and inserts source markers", async () => {
    const tmp = await makeTmp("mem-merge");
    try {
      const project = path.join(tmp, "proj");
      await fsp.mkdir(project, { recursive: true });
      const sources = [
        { path: path.join(project, "CLAUDE.md"), tool: "claude" as const, scope: "project" as const, content: "project body", depth: 0 },
        { path: path.join(tmp, "home", ".claude", "CLAUDE.md"), tool: "claude" as const, scope: "global" as const, content: "global body", depth: -1 },
      ];
      const merged = mergeMemory(sources);
      // Global should appear before project in the merged text.
      expect(merged.text.indexOf("global body")).toBeLessThan(merged.text.indexOf("project body"));
      expect(merged.text).toContain("<!-- from:");
      expect(merged.offsets).toHaveLength(2);
    } finally {
      await rmrf(tmp);
    }
  });
});

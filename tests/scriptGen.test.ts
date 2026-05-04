import { describe, it, expect } from "vitest";
import { __testing } from "../src/lib/backup/generateScripts";

const opts = {
  home: "/Users/xhu",
  joiner: { join: async (...p: string[]) => p.join("/") },
} as never;

describe("script tool sections", () => {
  it("emits one section per tool, plus claude_desktop when claude selected", async () => {
    const tools = __testing.normalizeTools(["claude", "codex", "cursor"]);
    const sources = await __testing.resolveToolSources(opts, tools);
    expect(sources.map((s) => s.destSubdir)).toEqual(["claude", "codex", "cursor", "claude_desktop"]);
  });

  it("derives source as parent of globalSkillsDir", async () => {
    const sources = await __testing.resolveToolSources(opts, ["codex"]);
    expect(sources[0].source).toBe("/Users/xhu/.codex");
  });

  it("renders unique destination subdirs without _backup suffix", async () => {
    const sources = await __testing.resolveToolSources(opts, ["claude", "codex", "cursor"]);
    const out = __testing.renderBashSections(sources, "/Users/xhu");
    expect(out).toContain('mkdir -p "$MIRROR/claude"');
    expect(out).toContain('mkdir -p "$MIRROR/codex"');
    expect(out).toContain('mkdir -p "$MIRROR/cursor"');
    expect(out).not.toMatch(/_backup/);
  });

  it("skips claude_desktop section when claude not selected", async () => {
    const sources = await __testing.resolveToolSources(opts, ["codex", "cursor"]);
    expect(sources.find((s) => s.kind === "claude_desktop")).toBeUndefined();
  });

  it("uses claude excludes only for claude, minimal for others", async () => {
    const sources = await __testing.resolveToolSources(opts, ["claude", "codex"]);
    const out = __testing.renderBashSections(sources, "/Users/xhu");
    expect(out).toMatch(/--exclude='cache\/'/); // claude
    // codex section should not have the cache/ exclude
    const codexBlock = out.split("Sync Codex").pop() ?? "";
    expect(codexBlock).not.toMatch(/--exclude='cache\/'/);
  });

  it("defaults undefined/empty selection to claude, but filters unknown to empty", async () => {
    expect(__testing.normalizeTools(undefined)).toEqual(["claude"]);
    expect(__testing.normalizeTools([])).toEqual(["claude"]);
    // Garbage entries are dropped — script will log "nothing to back up".
    expect(__testing.normalizeTools(["bogus"])).toEqual([]);
  });

  it("renders a no-op message when no tools resolve", async () => {
    const sources = await __testing.resolveToolSources(opts, []);
    const out = __testing.renderBashSections(sources, "/Users/xhu");
    expect(out).toBe('log "No tools selected — nothing to back up."');
  });
});

import { describe, expect, it } from "vitest";
import { findContradictions } from "../src/lib/memory/contradictions";
import type { MemorySource } from "../src/lib/memory/walker";

function src(path: string, content: string, scope: MemorySource["scope"] = "project"): MemorySource {
  return { path, tool: "claude", scope, content, depth: 0 };
}

describe("findContradictions", () => {
  it("flags opposing always/never with similar subjects", () => {
    const findings = findContradictions([
      src("/a/CLAUDE.md", "always use git rebase for merges.\n"),
      src("/b/CLAUDE.md", "never use git rebase. always use git merge.\n"),
    ]);
    const conflicts = findings.filter((f) => f.rule_id === "mem_imperative_conflict");
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((f) => f.message.includes("git rebase"))).toBe(true);
  });

  it("ignores non-conflicting imperatives", () => {
    const findings = findContradictions([
      src("/a/CLAUDE.md", "always use tabs.\n"),
      src("/b/CLAUDE.md", "always run tests before merging.\n"),
    ]);
    expect(findings.filter((f) => f.rule_id === "mem_imperative_conflict")).toHaveLength(0);
  });

  it("flags conflicting model overrides in same family", () => {
    const findings = findContradictions([
      src("/a/CLAUDE.md", "use claude-sonnet-4-6 for all tasks.\n"),
      src("/b/CLAUDE.md", "prefer claude-opus-4-7 when reasoning.\n"),
    ]);
    expect(findings.some((f) => f.rule_id === "mem_model_override_conflict")).toBe(true);
  });

  it("does not flag cross-family model directives", () => {
    const findings = findContradictions([
      src("/a/CLAUDE.md", "use claude-sonnet-4-6\n"),
      src("/b/AGENTS.md", "use gpt-5-mini\n"),
    ]);
    expect(findings.filter((f) => f.rule_id === "mem_model_override_conflict")).toHaveLength(0);
  });

  it("returns empty when only one source", () => {
    expect(findContradictions([src("/a/CLAUDE.md", "always use rebase\n")])).toEqual([]);
  });
});

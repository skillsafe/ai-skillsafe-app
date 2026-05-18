import { describe, expect, it } from "vitest";
import {
  type Candidate,
  cosineSimilarity,
  findConflicts,
  matchCandidates,
  tokenize,
} from "../src/lib/trigger/matcher";

const cand = (over: Partial<Candidate>): Candidate => ({
  id: "x",
  name: "x",
  tool: "claude",
  source: "global",
  description: "",
  ...over,
});

describe("tokenize", () => {
  it("lowercases, splits on non-alnum, drops short tokens and stopwords", () => {
    expect(tokenize("Run TESTS for the cli, including JavaScript ones."))
      .toEqual(["run", "tests", "cli", "including", "javascript", "ones"]);
  });
});

describe("matchCandidates", () => {
  const candidates: Candidate[] = [
    cand({ id: "1", name: "test-driven-development", description: "Use when implementing any feature or bugfix, before writing implementation code" }),
    cand({ id: "2", name: "review", description: "Review a pull request" }),
    cand({ id: "3", name: "security-scanner", description: "Scan for known security vulnerabilities across dependencies" }),
  ];

  it("returns ranked matches by token overlap", () => {
    const r = matchCandidates("scan dependencies for vulnerabilities", candidates);
    expect(r[0].candidate.id).toBe("3");
    expect(r[0].matchedTokens.length).toBeGreaterThan(0);
  });

  it("returns empty for unrelated query", () => {
    expect(matchCandidates("xyzpdq nothing matches", candidates)).toEqual([]);
  });

  it("annotates shadowing when project beats global with same name", () => {
    const proj = cand({ id: "p", name: "ship", description: "deploy code", source: "project", projectPath: "/repo" });
    const glob = cand({ id: "g", name: "ship", description: "deploy code", source: "global" });
    const r = matchCandidates("deploy code", [glob, proj]);
    const lookup = Object.fromEntries(r.map((m) => [m.candidate.id, m]));
    expect(lookup.p.shadowedBy).toBeUndefined();
    expect(lookup.g.shadowedBy).toBe("p");
  });
});

describe("findConflicts", () => {
  it("flags same-name pairs in the same tool", () => {
    const a = cand({ id: "a", name: "deploy", description: "ship to staging" });
    const b = cand({ id: "b", name: "deploy", description: "ship to prod" });
    const conflicts = findConflicts([a, b]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason).toBe("name");
  });

  it("flags near-identical descriptions even with different names", () => {
    const a = cand({ id: "a", name: "review-pr", description: "Review pull request changes and suggest improvements before merging" });
    const b = cand({ id: "b", name: "pr-review", description: "Review pull request changes and suggest improvements before merging" });
    const conflicts = findConflicts([a, b]);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("ignores cross-tool pairs", () => {
    const a = cand({ id: "a", name: "x", description: "do a thing", tool: "claude" });
    const b = cand({ id: "b", name: "x", description: "do a thing", tool: "codex" });
    expect(findConflicts([a, b])).toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical bags", () => {
    expect(cosineSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBeCloseTo(1, 5);
  });
  it("returns 0 for disjoint bags", () => {
    expect(cosineSimilarity(["a"], ["b"])).toBe(0);
  });
});

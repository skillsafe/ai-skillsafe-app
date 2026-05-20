import { describe, expect, it } from "vitest";
import {
  getStatusBlock,
  isQuarantined,
  isRewritten,
  setStatus,
} from "../src/lib/artifacts/status";

const base: { frontmatter: Record<string, unknown> } = { frontmatter: { name: "x" } };

describe("artifact status sentinel", () => {
  it("reads quarantined block", () => {
    const a = { frontmatter: { skillsafe: { status: "quarantined", reason: "matched" } } };
    expect(isQuarantined(a)).toBe(true);
    expect(getStatusBlock(a)).toEqual({ status: "quarantined", reason: "matched" });
  });

  it("reads rewritten block", () => {
    const a = { frontmatter: { skillsafe: { status: "rewritten" } } };
    expect(isRewritten(a)).toBe(true);
    expect(isQuarantined(a)).toBe(false);
  });

  it("ignores invalid status values", () => {
    const a = { frontmatter: { skillsafe: { status: "broken" } } };
    expect(getStatusBlock(a)).toBeNull();
    expect(isQuarantined(a)).toBe(false);
  });

  it("ignores non-object skillsafe key", () => {
    const a = { frontmatter: { skillsafe: "quarantined" } };
    expect(getStatusBlock(a)).toBeNull();
  });

  it("setStatus writes block immutably with timestamp", () => {
    const next = setStatus(base, "quarantined", "rule tx_inducement_setup", () => new Date("2026-05-20T10:00:00Z"));
    expect(next.frontmatter).not.toBe(base.frontmatter);
    expect(base.frontmatter).toEqual({ name: "x" });
    const block = getStatusBlock(next)!;
    expect(block.status).toBe("quarantined");
    expect(block.reason).toBe("rule tx_inducement_setup");
    expect(block.set_at).toBe("2026-05-20T10:00:00.000Z");
  });

  it("setStatus(clean) removes the block entirely", () => {
    const dirty = setStatus(base, "quarantined");
    expect(isQuarantined(dirty)).toBe(true);
    const cleaned = setStatus(dirty, "clean");
    expect(cleaned.frontmatter.skillsafe).toBeUndefined();
  });

  it("setStatus preserves unrelated keys under skillsafe namespace", () => {
    const a = { frontmatter: { skillsafe: { future_field: "value" } } };
    const next = setStatus(a, "quarantined");
    expect((next.frontmatter.skillsafe as any).future_field).toBe("value");
    expect((next.frontmatter.skillsafe as any).status).toBe("quarantined");
  });
});

import { describe, expect, it } from "vitest";
import { describeFields, validate } from "../src/lib/validate";

describe("validate", () => {
  it("rejects skill frontmatter missing name", () => {
    const r = validate("claude", "skill", { description: "x" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === "name")).toBe(true);
  });

  it("accepts a valid skill frontmatter and preserves passthrough fields", () => {
    const r = validate("claude", "skill", {
      name: "x",
      description: "y",
      "custom-field": "kept",
    });
    expect(r.ok).toBe(true);
    expect((r.data as Record<string, unknown>)["custom-field"]).toBe("kept");
  });

  it("uses the SKILL.md frontmatter schema for every tool's skill type", () => {
    // The cursor-rules and cline-rules schemas were retired when discovery
    // switched to vercel-labs/skills' SKILL.md-only model.
    const fields = describeFields("cursor", "skill");
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.name?.kind).toBe("string");
    expect(byName.name?.required).toBe(true);
    expect(byName.description?.kind).toBe("string");
    expect(byName.description?.required).toBe(true);
    expect(byName["allowed-tools"]?.kind).toBe("string[]");
  });
});

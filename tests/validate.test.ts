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

  it("describes Cursor rule fields with the right kinds", () => {
    const fields = describeFields("cursor", "skill");
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.alwaysApply.kind).toBe("boolean");
    expect(byName.globs.kind).toBe("string[]");
    expect(byName.description.kind).toBe("string");
  });
});

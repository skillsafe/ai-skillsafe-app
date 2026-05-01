import { describe, expect, it } from "vitest";
import { parseFrontmatter, stringifyFrontmatter } from "../src/lib/frontmatter";

describe("frontmatter", () => {
  it("parses YAML frontmatter and body", () => {
    const raw = "---\nname: foo\ndescription: bar baz\n---\n# Body\n\nhello\n";
    const { data, body } = parseFrontmatter(raw);
    expect(data.name).toBe("foo");
    expect(data.description).toBe("bar baz");
    expect(body.startsWith("# Body")).toBe(true);
  });

  it("round-trips through stringify", () => {
    const raw = "---\nname: foo\ndescription: bar\n---\n# Body\n\nx\n";
    const { data, body } = parseFrontmatter(raw);
    const back = stringifyFrontmatter(data, body);
    const reparsed = parseFrontmatter(back);
    expect(reparsed.data.name).toBe("foo");
    expect(reparsed.body.trim()).toBe("# Body\n\nx".trim());
  });

  it("handles markdown without frontmatter", () => {
    const raw = "just markdown\n";
    const { data, body } = parseFrontmatter(raw);
    expect(Object.keys(data)).toHaveLength(0);
    expect(body).toBe("just markdown\n");
  });
});

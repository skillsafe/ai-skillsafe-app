import { describe, expect, it } from "vitest";
import { convertArtifact } from "../src/lib/convert";
import type { MarkdownArtifact } from "../src/lib/artifacts/types";

function fixture(): MarkdownArtifact {
  return {
    id: "claude:global:skill:/x",
    tool: "claude",
    scope: "global",
    type: "skill",
    name: "test-skill",
    path: "/x/SKILL.md",
    isBundle: true,
    bundleDir: "/x",
    frontmatter: {
      name: "test-skill",
      description: "Use when reviewing code",
      "allowed-tools": ["Read", "Grep"],
      paths: ["src/**/*.ts"],
    },
    body: "# Body\n\nDo the thing.\n",
    raw: "",
    attachments: [],
  };
}

describe("convert", () => {
  it("Claude skill → Cursor skill produces a SKILL.md bundle (npx skills layout)", () => {
    // Cursor's `.cursor/rules/*.mdc` is a different concept from skills.
    // After aligning discovery with vercel-labs/skills, every tool's skill
    // type is a SKILL.md bundle.
    const out = convertArtifact(fixture(), { targetTool: "cursor", targetType: "skill" });
    expect(out.fileName).toBe("SKILL.md");
    expect(out.isBundle).toBe(true);
    expect(out.frontmatter.name).toBe("test-skill");
    expect(out.frontmatter.description).toBe("Use when reviewing code");
    expect(out.frontmatter["allowed-tools"]).toEqual(["Read", "Grep"]);
    expect(out.frontmatter.paths).toEqual(["src/**/*.ts"]);
    expect(out.body).toContain("Do the thing.");
  });

  it("Claude skill → Codex command becomes a single .md prompt", () => {
    const out = convertArtifact(fixture(), { targetTool: "codex", targetType: "command" });
    expect(out.fileName).toBe("test-skill.md");
    expect(out.isBundle).toBe(false);
    expect(out.body.startsWith("# Body")).toBe(true);
  });

  it("Claude skill → Claude command flattens to a file", () => {
    const out = convertArtifact(fixture(), { targetTool: "claude", targetType: "command" });
    expect(out.fileName).toBe("test-skill.md");
    expect(out.isBundle).toBe(false);
    expect(out.frontmatter.name).toBe("test-skill");
    expect(out.frontmatter["allowed-tools"]).toEqual(["Read", "Grep"]);
  });

  it("preserves Claude → Claude skill bundle", () => {
    const out = convertArtifact(fixture(), { targetTool: "claude", targetType: "skill" });
    expect(out.fileName).toBe("SKILL.md");
    expect(out.isBundle).toBe(true);
  });
});

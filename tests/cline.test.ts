import { describe, expect, it, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { listArtifacts } from "../src/lib/tools";
import { resolveArtifactDir, resetHomeCache } from "../src/lib/paths";
import { convertArtifact } from "../src/lib/convert";
import type { MarkdownArtifact } from "../src/lib/artifacts/types";
import { stringifyFrontmatter } from "../src/lib/frontmatter";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

describe("cline path resolution", () => {
  beforeEach(() => resetHomeCache());

  it("resolves project rules to <project>/.clinerules", async () => {
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "cline",
      "project",
      "skill",
      "/work/repo",
    );
    expect(dir).toBe("/work/repo/.clinerules");
  });

  it("resolves global rules to ~/Documents/Cline/Rules (per official docs)", async () => {
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "cline", "global", "skill");
    expect(dir).toBe("/Users/jane/Documents/Cline/Rules");
  });
});

describe("cline listing", () => {
  let home: string;

  beforeEach(async () => {
    resetHomeCache();
    home = await makeTmp("cline-home");
  });

  it("lists .md and .txt files from <project>/.clinerules", async () => {
    const project = await makeTmp("cline-proj");
    try {
      const rulesDir = path.join(project, ".clinerules");
      await fs.mkdir(rulesDir, { recursive: true });
      await fs.writeFile(
        path.join(rulesDir, "01-coding.md"),
        stringifyFrontmatter({ description: "coding rules", paths: ["src/**/*.ts"] }, "Be careful.\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(rulesDir, "02-style.txt"),
        "Plain text rule, no frontmatter.\n",
        "utf8",
      );

      const list = await listArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
        tool: "cline",
        scope: "project",
        type: "skill",
        projectRoot: project,
      });
      expect(list.length).toBe(2);
      const names = list.map((a) => a.name).sort();
      expect(names).toEqual(["01-coding", "02-style"]);
      const md = list.find((a) => a.path.endsWith(".md"))!;
      expect(md.tool).toBe("cline");
      expect(md.frontmatter.paths).toEqual(["src/**/*.ts"]);
    } finally {
      await rmrf(project);
      await rmrf(home);
    }
  });

  it("lists global rules from ~/Documents/Cline/Rules and ~/Cline/Rules fallback", async () => {
    try {
      const primary = path.join(home, "Documents", "Cline", "Rules");
      const fallback = path.join(home, "Cline", "Rules");
      await fs.mkdir(primary, { recursive: true });
      await fs.mkdir(fallback, { recursive: true });
      await fs.writeFile(
        path.join(primary, "team.md"),
        stringifyFrontmatter({ description: "team rule" }, "Be thoughtful.\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(fallback, "linux-only.txt"),
        "Rule from the documented Linux/WSL fallback location.\n",
        "utf8",
      );

      const list = await listArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
        tool: "cline",
        scope: "global",
        type: "skill",
      });
      const names = list.map((a) => a.name).sort();
      expect(names).toEqual(["linux-only", "team"]);
    } finally {
      await rmrf(home);
    }
  });

  it("returns empty for non-skill types", async () => {
    const project = await makeTmp("cline-proj-empty");
    try {
      const list = await listArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
        tool: "cline",
        scope: "project",
        type: "agent",
        projectRoot: project,
      });
      expect(list).toEqual([]);
    } finally {
      await rmrf(project);
      await rmrf(home);
    }
  });

  it("returns empty for lockfile scope", async () => {
    const list = await listArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "cline",
      scope: "lockfile",
      type: "skill",
    });
    expect(list).toEqual([]);
    await rmrf(home);
  });
});

describe("cline conversion", () => {
  function clineRule(): MarkdownArtifact {
    return {
      id: "cline:project:skill:/x",
      tool: "cline",
      scope: "project",
      type: "skill",
      name: "coding-rule",
      path: "/x/.clinerules/coding-rule.md",
      isBundle: false,
      frontmatter: {
        description: "Coding standards",
        paths: ["src/**/*.ts", "lib/**/*.ts"],
      },
      body: "Use 2-space indents.\n",
      raw: "",
      attachments: [],
    };
  }

  function cursorRule(): MarkdownArtifact {
    return {
      id: "cursor:project:skill:/x",
      tool: "cursor",
      scope: "project",
      type: "skill",
      name: "style-rule",
      path: "/x/.cursor/rules/style-rule.mdc",
      isBundle: false,
      frontmatter: {
        description: "Style standards",
        globs: ["src/**/*.tsx"],
        alwaysApply: false,
      },
      body: "Use Prettier defaults.\n",
      raw: "",
      attachments: [],
    };
  }

  it("cline → cursor rewrites paths to globs", () => {
    const out = convertArtifact(clineRule(), { targetTool: "cursor", targetType: "skill" });
    expect(out.fileName).toBe("coding-rule.mdc");
    expect(out.isBundle).toBe(false);
    expect(out.frontmatter.description).toBe("Coding standards");
    expect(out.frontmatter.globs).toEqual(["src/**/*.ts", "lib/**/*.ts"]);
    expect(out.frontmatter.paths).toBeUndefined();
    expect(out.body).toContain("2-space indents");
  });

  it("cursor → cline rewrites globs to paths", () => {
    const out = convertArtifact(cursorRule(), { targetTool: "cline", targetType: "skill" });
    expect(out.fileName).toBe("style-rule.md");
    expect(out.isBundle).toBe(false);
    expect(out.frontmatter.description).toBe("Style standards");
    expect(out.frontmatter.paths).toEqual(["src/**/*.tsx"]);
    expect(out.frontmatter.globs).toBeUndefined();
  });

  it("paths ↔ globs round-trips through cline → cursor → cline", () => {
    const original = clineRule();
    const cursorOut = convertArtifact(original, { targetTool: "cursor", targetType: "skill" });
    const intermediate: MarkdownArtifact = {
      ...original,
      tool: "cursor",
      frontmatter: cursorOut.frontmatter,
      body: cursorOut.body,
    };
    const clineOut = convertArtifact(intermediate, { targetTool: "cline", targetType: "skill" });
    expect(clineOut.frontmatter.paths).toEqual(original.frontmatter.paths);
  });
});

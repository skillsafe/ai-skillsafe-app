import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listHermesArtifacts } from "../src/lib/tools/hermes";
import { createSkillBundle } from "../src/lib/artifacts/skill";
import { convertArtifact } from "../src/lib/convert";
import { resolveArtifactDir, resetHomeCache } from "../src/lib/paths";
import type { MarkdownArtifact } from "../src/lib/artifacts/types";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

function fixture(tool: "claude" | "hermes"): MarkdownArtifact {
  return {
    id: `${tool}:global:skill:/x`,
    tool,
    scope: "global",
    type: "skill",
    name: "demo-skill",
    path: "/x/SKILL.md",
    isBundle: true,
    bundleDir: "/x",
    frontmatter: {
      name: "demo-skill",
      description: "Use when demoing",
      "allowed-tools": ["Read", "Grep"],
      paths: ["src/**/*.ts"],
    },
    body: "# Demo\n\nDo the thing.\n",
    raw: "",
    attachments: [],
  };
}

describe("hermes path resolution", () => {
  it("resolves Hermes global skill dir → ~/.hermes/skills", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "hermes", "global", "skill");
    expect(dir).toBe("/Users/jane/.hermes/skills");
  });

  it("resolves Hermes project skill dir → <project>/.hermes/skills", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "hermes",
      "project",
      "skill",
      "/work/repo",
    );
    expect(dir).toBe("/work/repo/.hermes/skills");
  });

  it("returns empty string for unsupported types", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "hermes", "global", "agent");
    expect(dir).toBe("");
  });
});

describe("hermes listing", () => {
  let home: string;
  let project: string;
  beforeEach(async () => {
    home = await makeTmp("hermes-home");
    project = await makeTmp("hermes-project");
    resetHomeCache();
  });
  afterEach(async () => {
    await rmrf(home);
    await rmrf(project);
  });

  it("lists global bundles directly under ~/.hermes/skills", async () => {
    const root = path.join(home, ".hermes", "skills");
    await fs.mkdir(root, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, root, "alpha", "first", "hermes", "global");
    await createSkillBundle(nodeFs, nodeJoiner, root, "beta", "second", "hermes", "global");

    const out = await listHermesArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "global",
      type: "skill",
    });
    const names = out.map((a) => a.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    expect(out.every((a) => a.tool === "hermes")).toBe(true);
  });

  it("descends into category subdirectories (~/.hermes/skills/<category>/<skill>/SKILL.md)", async () => {
    const root = path.join(home, ".hermes", "skills");
    const writing = path.join(root, "writing");
    const coding = path.join(root, "coding");
    await fs.mkdir(writing, { recursive: true });
    await fs.mkdir(coding, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, writing, "blog-post", "draft posts", "hermes", "global");
    await createSkillBundle(nodeFs, nodeJoiner, coding, "refactor", "rename safely", "hermes", "global");

    const out = await listHermesArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "global",
      type: "skill",
    });
    const names = out.map((a) => a.name).sort();
    expect(names).toEqual(["blog-post", "refactor"]);
  });

  it("mixes flat bundles and category-nested bundles without duplication", async () => {
    const root = path.join(home, ".hermes", "skills");
    const cat = path.join(root, "writing");
    await fs.mkdir(cat, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, root, "flat-skill", "flat", "hermes", "global");
    await createSkillBundle(nodeFs, nodeJoiner, cat, "nested-skill", "nested", "hermes", "global");

    const out = await listHermesArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "global",
      type: "skill",
    });
    const names = out.map((a) => a.name).sort();
    expect(names).toEqual(["flat-skill", "nested-skill"]);
  });

  it("lists project bundles from <project>/.hermes/skills", async () => {
    const root = path.join(project, ".hermes", "skills");
    await fs.mkdir(root, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, root, "proj", "p", "hermes", "project");

    const out = await listHermesArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "project",
      type: "skill",
      projectRoot: project,
    });
    expect(out.map((a) => a.name)).toEqual(["proj"]);
  });

  it("returns empty for agent / command / lockfile scopes", async () => {
    const agentsRes = await listHermesArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "global",
      type: "agent",
    });
    const cmdRes = await listHermesArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "global",
      type: "command",
    });
    const lockRes = await listHermesArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "lockfile",
      type: "skill",
    });
    expect(agentsRes).toEqual([]);
    expect(cmdRes).toEqual([]);
    expect(lockRes).toEqual([]);
  });
});

describe("hermes conversion", () => {
  it("Claude skill → Hermes skill produces an identical SKILL.md bundle", () => {
    const out = convertArtifact(fixture("claude"), {
      targetTool: "hermes",
      targetType: "skill",
    });
    expect(out.fileName).toBe("SKILL.md");
    expect(out.isBundle).toBe(true);
    expect(out.frontmatter.name).toBe("demo-skill");
    expect(out.frontmatter.description).toBe("Use when demoing");
    expect(out.frontmatter["allowed-tools"]).toEqual(["Read", "Grep"]);
    expect(out.frontmatter.paths).toEqual(["src/**/*.ts"]);
    expect(out.body).toContain("Do the thing.");
  });

  it("Hermes skill → Claude skill round-trips frontmatter", () => {
    const out = convertArtifact(fixture("hermes"), {
      targetTool: "claude",
      targetType: "skill",
    });
    expect(out.fileName).toBe("SKILL.md");
    expect(out.isBundle).toBe(true);
    expect(out.frontmatter.name).toBe("demo-skill");
    expect(out.frontmatter.description).toBe("Use when demoing");
    expect(out.frontmatter["allowed-tools"]).toEqual(["Read", "Grep"]);
    expect(out.frontmatter.paths).toEqual(["src/**/*.ts"]);
  });
});

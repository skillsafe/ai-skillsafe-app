import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listGenericSkills } from "../src/lib/tools/generic";
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

// Hermes is the only registry entry that's *not* in vercel-labs/skills — it's
// kept for the agentskills.io-style category-nested layout that several
// authors use under ~/.hermes/skills. These tests pin both the registry path
// (~/.hermes/skills, .hermes/skills) and the generic lister's nested-scan,
// which now applies to every agent that uses a similar layout.
describe("hermes path resolution", () => {
  it("resolves global → ~/.hermes/skills", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "hermes", "global", "skill");
    expect(dir).toBe("/Users/jane/.hermes/skills");
  });

  it("resolves project → <project>/.hermes/skills", async () => {
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

describe("hermes listing (via the generic registry-driven lister)", () => {
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

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
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

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
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

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
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

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "project",
      type: "skill",
      projectRoot: project,
    });
    expect(out.map((a) => a.name)).toEqual(["proj"]);
  });

  it("treats dot-prefixed top-level dirs (.system, .curated) as categories, not bundles", async () => {
    // vercel-labs/skills uses .system / .curated / .experimental as
    // category prefixes (see /tmp/skills-src/src/skills.ts:154-159). A
    // stray SKILL.md at .system/SKILL.md should NOT surface as a 1-bundle
    // catch-all named ".system"; instead, the real bundles inside it are
    // listed.
    const root = path.join(home, ".hermes", "skills");
    const sys = path.join(root, ".system");
    await fs.mkdir(sys, { recursive: true });
    // A spurious SKILL.md directly inside the category dir.
    await fs.writeFile(
      path.join(sys, "SKILL.md"),
      "---\nname: stray\ndescription: should-not-appear\n---\nbody\n",
    );
    // A real bundle inside the category — this is what the user expects.
    await createSkillBundle(nodeFs, nodeJoiner, sys, "skill-creator", "real", "hermes", "global");

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "global",
      type: "skill",
    });
    const names = out.map((a) => a.name).sort();
    expect(names).toEqual(["skill-creator"]);
  });

  it("returns empty for agent / command types", async () => {
    const agentsRes = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "global",
      type: "agent",
    });
    const cmdRes = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "hermes",
      scope: "global",
      type: "command",
    });
    expect(agentsRes).toEqual([]);
    expect(cmdRes).toEqual([]);
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

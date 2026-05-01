import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listOpenclawArtifacts } from "../src/lib/tools/openclaw";
import { createSkillBundle } from "../src/lib/artifacts/skill";
import { convertArtifact } from "../src/lib/convert";
import { resolveArtifactDir, resetHomeCache } from "../src/lib/paths";
import type { MarkdownArtifact } from "../src/lib/artifacts/types";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

function fixture(tool: "claude" | "openclaw"): MarkdownArtifact {
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

describe("openclaw path resolution", () => {
  it("resolves OpenClaw global skill dir → ~/.openclaw/skills", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "openclaw",
      "global",
      "skill",
    );
    expect(dir).toBe("/Users/jane/.openclaw/skills");
  });

  it("resolves OpenClaw project skill dir → <project>/skills", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "openclaw",
      "project",
      "skill",
      "/work/repo",
    );
    expect(dir).toBe("/work/repo/skills");
  });

  it("returns empty string for unsupported types", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "openclaw",
      "global",
      "agent",
    );
    expect(dir).toBe("");
  });
});

describe("openclaw listing", () => {
  let home: string;
  let project: string;
  beforeEach(async () => {
    home = await makeTmp("openclaw-home");
    project = await makeTmp("openclaw-project");
    resetHomeCache();
  });
  afterEach(async () => {
    await rmrf(home);
    await rmrf(project);
  });

  it("lists project bundles from both <project>/skills and <project>/.agents/skills", async () => {
    const wsSkills = path.join(project, "skills");
    const agentsSkills = path.join(project, ".agents", "skills");
    await fs.mkdir(wsSkills, { recursive: true });
    await fs.mkdir(agentsSkills, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, wsSkills, "alpha", "first", "openclaw", "project");
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      agentsSkills,
      "beta",
      "second",
      "openclaw",
      "project",
    );

    const out = await listOpenclawArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "openclaw",
      scope: "project",
      type: "skill",
      projectRoot: project,
    });
    const names = out.map((a) => a.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    expect(out.every((a) => a.tool === "openclaw")).toBe(true);
  });

  it("lists global bundles from both ~/.openclaw/skills and ~/.agents/skills", async () => {
    const oc = path.join(home, ".openclaw", "skills");
    const agents = path.join(home, ".agents", "skills");
    await fs.mkdir(oc, { recursive: true });
    await fs.mkdir(agents, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, oc, "pinned", "p", "openclaw", "global");
    await createSkillBundle(nodeFs, nodeJoiner, agents, "personal", "x", "openclaw", "global");

    const out = await listOpenclawArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "openclaw",
      scope: "global",
      type: "skill",
    });
    const names = out.map((a) => a.name).sort();
    expect(names).toEqual(["personal", "pinned"]);
  });

  it("returns empty for agent / command types", async () => {
    const agentsRes = await listOpenclawArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "openclaw",
      scope: "global",
      type: "agent",
    });
    const cmdRes = await listOpenclawArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "openclaw",
      scope: "global",
      type: "command",
    });
    expect(agentsRes).toEqual([]);
    expect(cmdRes).toEqual([]);
  });
});

describe("openclaw conversion", () => {
  it("Claude skill → OpenClaw skill produces an identical SKILL.md bundle", () => {
    const out = convertArtifact(fixture("claude"), {
      targetTool: "openclaw",
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

  it("OpenClaw skill → Claude skill round-trips frontmatter", () => {
    const out = convertArtifact(fixture("openclaw"), {
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

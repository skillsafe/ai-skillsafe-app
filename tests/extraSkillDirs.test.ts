import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listGenericSkills } from "../src/lib/tools/generic";
import { createSkillBundle } from "../src/lib/artifacts/skill";
import { resetHomeCache } from "../src/lib/paths";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

// Bug origin: a SKILL.md bundle at ~/.agents/skills/skillsafe/ wasn't listed
// under the Pi view, even though Pi's official docs (pi.dev/docs/latest/skills)
// say Pi reads BOTH ~/.pi/agent/skills AND ~/.agents/skills. These tests pin
// the cross-tool `.agents/skills` extra scan paths for agents whose docs
// explicitly enumerate them.
describe("cross-tool `.agents/skills` extra scan paths (per upstream docs)", () => {
  let home: string;
  let project: string;
  beforeEach(async () => {
    home = await makeTmp("extras-home");
    project = await makeTmp("extras-project");
    resetHomeCache();
  });
  afterEach(async () => {
    await rmrf(home);
    await rmrf(project);
  });

  it("Pi global lists bundles from ~/.agents/skills in addition to ~/.pi/agent/skills", async () => {
    const piDir = path.join(home, ".pi", "agent", "skills");
    const sharedDir = path.join(home, ".agents", "skills");
    await fs.mkdir(piDir, { recursive: true });
    await fs.mkdir(sharedDir, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, piDir, "pi-native", "x", "pi", "global");
    await createSkillBundle(nodeFs, nodeJoiner, sharedDir, "skillsafe", "x", "pi", "global");

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "pi",
      scope: "global",
      type: "skill",
    });
    expect(out.map((a) => a.name).sort()).toEqual(["pi-native", "skillsafe"]);
  });

  it("Pi project lists bundles from both .pi/skills and .agents/skills", async () => {
    await fs.mkdir(path.join(project, ".pi", "skills"), { recursive: true });
    await fs.mkdir(path.join(project, ".agents", "skills"), { recursive: true });
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(project, ".pi", "skills"),
      "a",
      "x",
      "pi",
      "project",
    );
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(project, ".agents", "skills"),
      "b",
      "x",
      "pi",
      "project",
    );

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "pi",
      scope: "project",
      type: "skill",
      projectRoot: project,
    });
    expect(out.map((a) => a.name).sort()).toEqual(["a", "b"]);
  });

  it("Codex global lists bundles from both ~/.codex/skills and ~/.agents/skills", async () => {
    const codexDir = path.join(home, ".codex", "skills");
    const sharedDir = path.join(home, ".agents", "skills");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.mkdir(sharedDir, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, codexDir, "native", "x", "codex", "global");
    await createSkillBundle(nodeFs, nodeJoiner, sharedDir, "shared", "x", "codex", "global");

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "codex",
      scope: "global",
      type: "skill",
    });
    expect(out.map((a) => a.name).sort()).toEqual(["native", "shared"]);
  });

  it("Gemini CLI global lists bundles from both ~/.gemini/skills and ~/.agents/skills", async () => {
    await fs.mkdir(path.join(home, ".gemini", "skills"), { recursive: true });
    await fs.mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".gemini", "skills"),
      "g",
      "x",
      "gemini-cli",
      "global",
    );
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".agents", "skills"),
      "shared",
      "x",
      "gemini-cli",
      "global",
    );

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "gemini-cli",
      scope: "global",
      type: "skill",
    });
    expect(out.map((a) => a.name).sort()).toEqual(["g", "shared"]);
  });

  it("Goose global picks up both XDG ~/.config/agents/skills and ~/.agents/skills extras", async () => {
    await fs.mkdir(path.join(home, ".config", "goose", "skills"), { recursive: true });
    await fs.mkdir(path.join(home, ".config", "agents", "skills"), { recursive: true });
    await fs.mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".config", "goose", "skills"),
      "native",
      "x",
      "goose",
      "global",
    );
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".config", "agents", "skills"),
      "xdg-shared",
      "x",
      "goose",
      "global",
    );
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".agents", "skills"),
      "home-shared",
      "x",
      "goose",
      "global",
    );

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "goose",
      scope: "global",
      type: "skill",
    });
    expect(out.map((a) => a.name).sort()).toEqual(["home-shared", "native", "xdg-shared"]);
  });

  it("Roo Code project scans .agents/skills extra (workspace cross-agent path)", async () => {
    await fs.mkdir(path.join(project, ".roo", "skills"), { recursive: true });
    await fs.mkdir(path.join(project, ".agents", "skills"), { recursive: true });
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(project, ".roo", "skills"),
      "roo-native",
      "x",
      "roo",
      "project",
    );
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(project, ".agents", "skills"),
      "shared",
      "x",
      "roo",
      "project",
    );

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "roo",
      scope: "project",
      type: "skill",
      projectRoot: project,
    });
    expect(out.map((a) => a.name).sort()).toEqual(["roo-native", "shared"]);
  });

  it("Roo Code global does NOT scan ~/.agents/skills (no global extra; docs don't enumerate one)", async () => {
    await fs.mkdir(path.join(home, ".roo", "skills"), { recursive: true });
    await fs.mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".roo", "skills"),
      "roo-only",
      "x",
      "roo",
      "global",
    );
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".agents", "skills"),
      "should-not-appear",
      "x",
      "roo",
      "global",
    );

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "roo",
      scope: "global",
      type: "skill",
    });
    expect(out.map((a) => a.name)).toEqual(["roo-only"]);
  });

  it("Claude global keeps Anthropic's ~/.claude/skills scope only (no ~/.agents/skills global)", async () => {
    await fs.mkdir(path.join(home, ".claude", "skills"), { recursive: true });
    await fs.mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".claude", "skills"),
      "claude-skill",
      "x",
      "claude",
      "global",
    );
    await createSkillBundle(
      nodeFs,
      nodeJoiner,
      path.join(home, ".agents", "skills"),
      "should-not-appear",
      "x",
      "claude",
      "global",
    );

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "claude",
      scope: "global",
      type: "skill",
    });
    expect(out.map((a) => a.name)).toEqual(["claude-skill"]);
  });

  it("dedup: a bundle visible under two scan paths appears once", async () => {
    // Cline declares `~/.agents/skills` as its primary AND has no extras —
    // so this exercises the dedup guard for any future agent where primary
    // and an extra accidentally resolve to the same directory.
    const sharedDir = path.join(home, ".agents", "skills");
    await fs.mkdir(sharedDir, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, sharedDir, "only-once", "x", "cline", "global");

    const out = await listGenericSkills(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "cline",
      scope: "global",
      type: "skill",
    });
    expect(out.map((a) => a.name)).toEqual(["only-once"]);
  });
});

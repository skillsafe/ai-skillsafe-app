import { describe, expect, it } from "vitest";
import { resolveArtifactDir, resolveSkillScanDirs, resetHomeCache } from "../src/lib/paths";
import { pathDeps } from "./_helpers";

describe("path resolver", () => {
  it("resolves Claude global skill dir", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "claude", "global", "skill");
    expect(dir).toBe("/Users/jane/.claude/skills");
  });

  it("resolves Claude project agent dir under .claude/", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "claude",
      "project",
      "agent",
      "/work/repo",
    );
    expect(dir).toBe("/work/repo/.claude/agents");
  });

  it("resolves Claude project command dir under .claude/", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "claude",
      "project",
      "command",
      "/work/repo",
    );
    expect(dir).toBe("/work/repo/.claude/commands");
  });

  it("resolves Codex global commands → ~/.codex/prompts", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "codex", "global", "command");
    expect(dir).toBe("/Users/jane/.codex/prompts");
  });

  it("resolves Cursor project skills → <project>/.agents/skills (npx skills layout)", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "cursor",
      "project",
      "skill",
      "/work/repo",
    );
    expect(dir).toBe("/work/repo/.agents/skills");
  });

  it("resolves Cursor global skills → ~/.cursor/skills (npx skills layout)", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "cursor", "global", "skill");
    expect(dir).toBe("/Users/jane/.cursor/skills");
  });

  it("returns empty string for cursor agent/command (npx skills is skill-only)", async () => {
    resetHomeCache();
    const cmd = await resolveArtifactDir(pathDeps("/Users/jane"), "cursor", "global", "command");
    const ag = await resolveArtifactDir(pathDeps("/Users/jane"), "cursor", "global", "agent");
    expect(cmd).toBe("");
    expect(ag).toBe("");
  });

  it("resolves a non-Claude/Codex agent (e.g. Goose) via the registry", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "goose", "global", "skill");
    // Mirrors vercel-labs/skills: configHome/goose/skills → ~/.config/goose/skills
    expect(dir).toBe("/Users/jane/.config/goose/skills");
  });
});

// `resolveSkillScanDirs` returns primary + extras; the lister scans them all
// and dedupes by canonical bundle path. The agents below have their extras
// confirmed against their respective official docs (links in registry.ts).
describe("resolveSkillScanDirs — primary + extras", () => {
  it("Pi global: scans both ~/.pi/agent/skills and ~/.agents/skills", async () => {
    resetHomeCache();
    const dirs = await resolveSkillScanDirs(pathDeps("/Users/jane"), "pi", "global");
    expect(dirs).toEqual(["/Users/jane/.pi/agent/skills", "/Users/jane/.agents/skills"]);
  });

  it("Pi project: scans both .pi/skills and .agents/skills", async () => {
    resetHomeCache();
    const dirs = await resolveSkillScanDirs(pathDeps("/Users/jane"), "pi", "project", "/work/r");
    expect(dirs).toEqual(["/work/r/.pi/skills", "/work/r/.agents/skills"]);
  });

  it("Codex global: scans both ~/.codex/skills and ~/.agents/skills", async () => {
    resetHomeCache();
    const dirs = await resolveSkillScanDirs(pathDeps("/Users/jane"), "codex", "global");
    expect(dirs).toEqual(["/Users/jane/.codex/skills", "/Users/jane/.agents/skills"]);
  });

  it("Goose: includes XDG ~/.config/agents/skills and ~/.agents/skills extras", async () => {
    resetHomeCache();
    const dirs = await resolveSkillScanDirs(pathDeps("/Users/jane"), "goose", "global");
    expect(dirs).toEqual([
      "/Users/jane/.config/goose/skills",
      "/Users/jane/.agents/skills",
      "/Users/jane/.config/agents/skills",
    ]);
  });

  it("Claude global: no extras (Anthropic docs only list ~/.claude/skills)", async () => {
    resetHomeCache();
    const dirs = await resolveSkillScanDirs(pathDeps("/Users/jane"), "claude", "global");
    expect(dirs).toEqual(["/Users/jane/.claude/skills"]);
  });

  it("Claude project: keeps .agents/skills extra for `npx skills add` interop", async () => {
    resetHomeCache();
    const dirs = await resolveSkillScanDirs(
      pathDeps("/Users/jane"),
      "claude",
      "project",
      "/work/r",
    );
    expect(dirs).toEqual(["/work/r/.claude/skills", "/work/r/.agents/skills"]);
  });

  it("Cline: primary is already ~/.agents/skills — no duplicate from extras", async () => {
    resetHomeCache();
    // Cline declares `~/.agents/skills` as its primary global. We didn't add
    // any extras for it. The dedup in the helper keeps the list clean even
    // if a future edit accidentally adds `universalGlobalSkillsDir` as an extra.
    const dirs = await resolveSkillScanDirs(pathDeps("/Users/jane"), "cline", "global");
    expect(dirs).toEqual(["/Users/jane/.agents/skills"]);
  });

  it("Unknown agent returns []", async () => {
    resetHomeCache();
    const dirs = await resolveSkillScanDirs(pathDeps("/Users/jane"), "not-an-agent" as any, "global");
    expect(dirs).toEqual([]);
  });

  it("Project scope without projectRoot returns []", async () => {
    resetHomeCache();
    const dirs = await resolveSkillScanDirs(pathDeps("/Users/jane"), "pi", "project");
    expect(dirs).toEqual([]);
  });
});

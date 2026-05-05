import { describe, expect, it } from "vitest";
import { resolveArtifactDir, resetHomeCache } from "../src/lib/paths";
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

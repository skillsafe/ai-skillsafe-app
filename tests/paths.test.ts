import { describe, expect, it } from "vitest";
import { resolveArtifactDir, resetHomeCache } from "../src/lib/paths";
import { pathDeps } from "./_helpers";

describe("path resolver", () => {
  it("resolves Claude global skill dir", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "claude", "global", "skill");
    expect(dir).toBe("/Users/jane/.claude/skills");
  });

  it("resolves Claude project agent dir under .agents/", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "claude",
      "project",
      "agent",
      "/work/repo",
    );
    expect(dir).toBe("/work/repo/.agents/agents");
  });

  it("resolves Codex global commands → ~/.codex/prompts", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(pathDeps("/Users/jane"), "codex", "global", "command");
    expect(dir).toBe("/Users/jane/.codex/prompts");
  });

  it("resolves Cursor project rules → <project>/.cursor/rules", async () => {
    resetHomeCache();
    const dir = await resolveArtifactDir(
      pathDeps("/Users/jane"),
      "cursor",
      "project",
      "skill",
      "/work/repo",
    );
    expect(dir).toBe("/work/repo/.cursor/rules");
  });
});

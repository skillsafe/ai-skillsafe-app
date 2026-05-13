import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallDir } from "../src/lib/skillsafe/install";
import { createSkillBundle, deleteSkillBundle, loadSkillBundle } from "../src/lib/artifacts/skill";
import { resolveDeletePreview } from "../src/lib/artifacts/deletePreview";
import { listClaudeArtifacts } from "../src/lib/tools/claude";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

// Legacy installs (pre-symlink-removal) wrote the bundle under
// <project>/.agents/skills/<name> and bridged it via a relative symlink at
// <project>/.claude/skills/<name>. New installs write directly to
// <project>/.claude/skills/<name>, but the cleanup/listing paths still need
// to handle existing bridged installs without surprising the user.
async function makeLegacyBridge(projectRoot: string, name: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, ".claude", "skills"), { recursive: true });
  await fs.symlink(
    path.join("..", "..", ".agents", "skills", name),
    path.join(projectRoot, ".claude", "skills", name),
  );
}

describe("Claude project install (direct .claude/skills layout)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("bridge");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("resolveInstallDir returns .claude/skills/<n> for Claude project installs", async () => {
    const dir = await resolveInstallDir(
      pathDeps(tmp),
      nodeJoiner,
      "claude",
      "project",
      tmp,
      "demo",
    );
    expect(dir).toBe(path.join(tmp, ".claude", "skills", "demo"));
  });

  it("plain bundle in .claude/skills is removed cleanly by deleteSkillBundle", async () => {
    const claudeSkills = path.join(tmp, ".claude", "skills");
    await fs.mkdir(claudeSkills, { recursive: true });
    const created = await createSkillBundle(
      nodeFs,
      nodeJoiner,
      claudeSkills,
      "plain",
      "x",
      "claude",
      "project",
    );
    await deleteSkillBundle(nodeFs, created);
    expect(await nodeFs.exists(created.bundleDir!)).toBe(false);
  });

  it("resolveDeletePreview reports a single path for a plain bundle (no cascade)", async () => {
    const claudeSkills = path.join(tmp, ".claude", "skills");
    await fs.mkdir(claudeSkills, { recursive: true });
    const created = await createSkillBundle(
      nodeFs,
      nodeJoiner,
      claudeSkills,
      "preview1",
      "x",
      "claude",
      "project",
    );
    const preview = await resolveDeletePreview(nodeFs, nodeJoiner, created);
    expect(preview.primaryPath).toBe(created.bundleDir);
    expect(preview.primaryIsSymlink).toBe(false);
    expect(preview.bridgeSymlinkPath).toBeNull();
  });
});

describe("Legacy bridged install — back-compat cleanup", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("bridge-legacy");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("deleteSkillBundle removes both the .agents bundle and the bridge symlink", async () => {
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    const created = await createSkillBundle(
      nodeFs,
      nodeJoiner,
      agentsParent,
      "doomed",
      "x",
      "claude",
      "project",
    );
    await makeLegacyBridge(tmp, "doomed");
    const linkPath = path.join(tmp, ".claude", "skills", "doomed");
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

    await deleteSkillBundle(nodeFs, created);

    expect(await nodeFs.exists(created.bundleDir!)).toBe(false);
    await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deleteSkillBundle leaves a real (non-symlink) .claude/skills/<n> alone", async () => {
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    const created = await createSkillBundle(
      nodeFs,
      nodeJoiner,
      agentsParent,
      "shared",
      "x",
      "claude",
      "project",
    );
    // Real directory at the bridge location (user populated it before
    // SkillSafe got there, or replaced the link with real content).
    const realDir = path.join(tmp, ".claude", "skills", "shared");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "user.md"), "keep me\n");

    await deleteSkillBundle(nodeFs, created);

    expect(await fs.readFile(path.join(realDir, "user.md"), "utf8")).toBe("keep me\n");
  });

  it("when bundleDir IS the symlink, only the link is unlinked — real bundle survives", async () => {
    // If the artifact was loaded via the .claude/skills/<n> symlink (bundleDir
    // points at the link itself), `deleteSkillBundle` must NOT recursive-rm
    // through the link.
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, agentsParent, "linkonly", "x", "claude", "project");
    await makeLegacyBridge(tmp, "linkonly");

    const linkPath = path.join(tmp, ".claude", "skills", "linkonly");
    const artifactViaLink = await loadSkillBundle(
      nodeFs,
      nodeJoiner,
      linkPath,
      "claude",
      "project",
    );
    expect(artifactViaLink.bundleDir).toBe(linkPath);

    await deleteSkillBundle(nodeFs, artifactViaLink);

    // The symlink is gone…
    await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
    // …but the real bundle in .agents/skills/<n>/ is intact.
    const realBundle = path.join(tmp, ".agents", "skills", "linkonly");
    expect(await nodeFs.exists(realBundle)).toBe(true);
    expect(await nodeFs.exists(path.join(realBundle, "SKILL.md"))).toBe(true);
  });

  it("listClaudeArtifacts dedupes the bridge symlink (skill appears once, canonical bundleDir)", async () => {
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, agentsParent, "single", "x", "claude", "project");
    await makeLegacyBridge(tmp, "single");

    const artifacts = await listClaudeArtifacts(nodeFs, nodeJoiner, pathDeps(tmp), {
      tool: "claude",
      scope: "project",
      type: "skill",
      projectRoot: tmp,
    });
    const matches = artifacts.filter((a) => a.name === "single");
    expect(matches).toHaveLength(1);
    expect(matches[0].bundleDir).toBe(path.join(tmp, ".agents", "skills", "single"));
  });

  it("resolveDeletePreview reports primary + bridge for a legacy bridged install", async () => {
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    const created = await createSkillBundle(
      nodeFs,
      nodeJoiner,
      agentsParent,
      "preview2",
      "x",
      "claude",
      "project",
    );
    await makeLegacyBridge(tmp, "preview2");

    const preview = await resolveDeletePreview(nodeFs, nodeJoiner, created);
    expect(preview.primaryPath).toBe(created.bundleDir);
    expect(preview.primaryIsSymlink).toBe(false);
    expect(preview.bridgeSymlinkPath).toBe(path.join(tmp, ".claude", "skills", "preview2"));
  });

  it("resolveDeletePreview flags primaryIsSymlink when the artifact is the link itself", async () => {
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, agentsParent, "preview3", "x", "claude", "project");
    await makeLegacyBridge(tmp, "preview3");
    const linkPath = path.join(tmp, ".claude", "skills", "preview3");
    const artifactViaLink = await loadSkillBundle(nodeFs, nodeJoiner, linkPath, "claude", "project");

    const preview = await resolveDeletePreview(nodeFs, nodeJoiner, artifactViaLink);
    expect(preview.primaryIsSymlink).toBe(true);
    expect(preview.bridgeSymlinkPath).toBeNull();
  });

  it("loadSkillBundle works through the bridge symlink", async () => {
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, agentsParent, "via-link", "y", "claude", "project");
    await makeLegacyBridge(tmp, "via-link");

    const linkDir = path.join(tmp, ".claude", "skills", "via-link");
    const reloaded = await loadSkillBundle(nodeFs, nodeJoiner, linkDir, "claude", "project");
    expect(reloaded.name).toBe("via-link");
  });
});

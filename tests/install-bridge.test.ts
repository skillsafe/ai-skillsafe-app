import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeSkillsBridge, resolveInstallDir } from "../src/lib/skillsafe/install";
import { createSkillBundle, deleteSkillBundle, loadSkillBundle } from "../src/lib/artifacts/skill";
import { resolveDeletePreview } from "../src/lib/artifacts/deletePreview";
import { listClaudeArtifacts } from "../src/lib/tools/claude";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

describe("Claude project install bridge", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("bridge");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("creates a relative symlink from .claude/skills/<n> to .agents/skills/<n>", async () => {
    // Simulate the install having already written the bundle.
    const agentsDir = path.join(tmp, ".agents", "skills", "demo");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(path.join(agentsDir, "SKILL.md"), "# demo\n");

    await createClaudeSkillsBridge(nodeFs, nodeJoiner, tmp, "demo");

    const linkPath = path.join(tmp, ".claude", "skills", "demo");
    const lst = await fs.lstat(linkPath);
    expect(lst.isSymbolicLink()).toBe(true);

    // Relative target — survives moving projectRoot.
    const target = await fs.readlink(linkPath);
    expect(target).toBe(path.join("..", "..", ".agents", "skills", "demo"));

    // Resolves to the real bundle.
    const resolved = await fs.realpath(linkPath);
    expect(resolved).toBe(await fs.realpath(agentsDir));
    const linkedFile = await fs.readFile(path.join(linkPath, "SKILL.md"), "utf8");
    expect(linkedFile).toContain("# demo");
  });

  it("skips when .claude/skills/<n> already exists (no clobber)", async () => {
    const agentsDir = path.join(tmp, ".agents", "skills", "x");
    await fs.mkdir(agentsDir, { recursive: true });

    // User-authored content sitting at the bridge target — must not be touched.
    const realDir = path.join(tmp, ".claude", "skills", "x");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "user.md"), "do not delete\n");

    await createClaudeSkillsBridge(nodeFs, nodeJoiner, tmp, "x");

    const lst = await fs.lstat(realDir);
    expect(lst.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(realDir, "user.md"), "utf8")).toBe("do not delete\n");
  });

  it("deleteSkillBundle removes the bridge symlink", async () => {
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
    await createClaudeSkillsBridge(nodeFs, nodeJoiner, tmp, "doomed");
    const linkPath = path.join(tmp, ".claude", "skills", "doomed");
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

    await deleteSkillBundle(nodeFs, created);

    expect(await nodeFs.exists(created.bundleDir!)).toBe(false);
    // Bridge link is gone too — no orphaned broken symlink left behind.
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
    // Real directory at the bridge location (e.g. user populated it before
    // SkillSafe got there, or replaced the link with real content).
    const realDir = path.join(tmp, ".claude", "skills", "shared");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "user.md"), "keep me\n");

    await deleteSkillBundle(nodeFs, created);

    expect(await fs.readFile(path.join(realDir, "user.md"), "utf8")).toBe("keep me\n");
  });

  it("createClaudeSkillsBridge is a no-op when fs adapter has no symlink", async () => {
    const noSymlinkFs = { ...nodeFs, symlink: undefined };
    await fs.mkdir(path.join(tmp, ".agents", "skills", "x"), { recursive: true });
    await createClaudeSkillsBridge(noSymlinkFs, nodeJoiner, tmp, "x");
    expect(await nodeFs.exists(path.join(tmp, ".claude", "skills", "x"))).toBe(false);
  });

  it("resolveInstallDir returns .agents/skills/<n> for Claude project with symlink (default)", async () => {
    const dir = await resolveInstallDir(
      pathDeps(tmp),
      nodeJoiner,
      "claude",
      "project",
      tmp,
      "demo",
      true,
    );
    expect(dir).toBe(path.join(tmp, ".agents", "skills", "demo"));
  });

  it("resolveInstallDir returns .claude/skills/<n> for Claude project when symlink disabled", async () => {
    const dir = await resolveInstallDir(
      pathDeps(tmp),
      nodeJoiner,
      "claude",
      "project",
      tmp,
      "demo",
      false,
    );
    expect(dir).toBe(path.join(tmp, ".claude", "skills", "demo"));
  });

  it("listClaudeArtifacts dedupes the bridge symlink (skill appears once, canonical bundleDir)", async () => {
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, agentsParent, "single", "x", "claude", "project");
    await createClaudeSkillsBridge(nodeFs, nodeJoiner, tmp, "single");

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

  it("delete case 1 (no symlink): plain bundle removed cleanly", async () => {
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

  it("delete case 2 (symlink install via .agents/skills bundleDir): bundle + bridge removed", async () => {
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
    await createClaudeSkillsBridge(nodeFs, nodeJoiner, tmp, "shared");

    await deleteSkillBundle(nodeFs, created);

    expect(await nodeFs.exists(created.bundleDir!)).toBe(false);
    await expect(fs.lstat(path.join(tmp, ".claude", "skills", "shared")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("delete case 3 (bundleDir IS the symlink): only the link is unlinked, real bundle survives", async () => {
    // Simulate the legacy/buggy flow where the artifact was loaded via the
    // .claude/skills/<n> symlink (bundleDir points at the link itself).
    // The hardened deleteSkillBundle must NOT recursive-rm through the link.
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, agentsParent, "linkonly", "x", "claude", "project");
    await createClaudeSkillsBridge(nodeFs, nodeJoiner, tmp, "linkonly");

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

  it("resolveDeletePreview reports primary + bridge for a symlink install", async () => {
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
    await createClaudeSkillsBridge(nodeFs, nodeJoiner, tmp, "preview2");

    const preview = await resolveDeletePreview(nodeFs, nodeJoiner, created);
    expect(preview.primaryPath).toBe(created.bundleDir);
    expect(preview.primaryIsSymlink).toBe(false);
    expect(preview.bridgeSymlinkPath).toBe(path.join(tmp, ".claude", "skills", "preview2"));
  });

  it("resolveDeletePreview flags primaryIsSymlink when the artifact is the link itself", async () => {
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, agentsParent, "preview3", "x", "claude", "project");
    await createClaudeSkillsBridge(nodeFs, nodeJoiner, tmp, "preview3");
    const linkPath = path.join(tmp, ".claude", "skills", "preview3");
    const artifactViaLink = await loadSkillBundle(nodeFs, nodeJoiner, linkPath, "claude", "project");

    const preview = await resolveDeletePreview(nodeFs, nodeJoiner, artifactViaLink);
    expect(preview.primaryIsSymlink).toBe(true);
    expect(preview.bridgeSymlinkPath).toBeNull();
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

  it("loadSkillBundle works through the bridge symlink", async () => {
    const agentsParent = path.join(tmp, ".agents", "skills");
    await fs.mkdir(agentsParent, { recursive: true });
    await createSkillBundle(nodeFs, nodeJoiner, agentsParent, "via-link", "y", "claude", "project");
    await createClaudeSkillsBridge(nodeFs, nodeJoiner, tmp, "via-link");

    const linkDir = path.join(tmp, ".claude", "skills", "via-link");
    const reloaded = await loadSkillBundle(nodeFs, nodeJoiner, linkDir, "claude", "project");
    expect(reloaded.name).toBe("via-link");
  });
});

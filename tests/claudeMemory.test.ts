import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listClaudeArtifacts } from "../src/lib/tools/claude";
import { runBackup } from "../src/lib/backup/runBackup";
import { restoreFromBackup } from "../src/lib/backup/single";
import { resetHomeCache } from "../src/lib/paths";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

describe("CLAUDE.md as claude agent artifact", () => {
  let home: string;
  let project: string;

  beforeEach(async () => {
    resetHomeCache();
    home = await makeTmp("claude-md-home");
    project = await makeTmp("claude-md-project");
  });

  afterEach(async () => {
    await rmrf(home);
    await rmrf(project);
  });

  it("lists ~/.claude/CLAUDE.md when type=agent and scope=global", async () => {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude", "CLAUDE.md"),
      "# Personal memory\n\nUse 2-space indents.\n",
    );

    const out = await listClaudeArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "claude",
      scope: "global",
      type: "agent",
    });
    const memory = out.find((a) => a.name === "CLAUDE.md");
    expect(memory).toBeDefined();
    expect(memory?.path).toBe(path.join(home, ".claude", "CLAUDE.md"));
    expect(memory?.body).toContain("2-space indents");
    expect(memory?.tool).toBe("claude");
    expect(memory?.type).toBe("agent");
  });

  it("lists <project>/CLAUDE.md when type=agent and scope=project", async () => {
    await fs.writeFile(path.join(project, "CLAUDE.md"), "# Project memory\n");

    const out = await listClaudeArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "claude",
      scope: "project",
      type: "agent",
      projectRoot: project,
    });
    const memory = out.find((a) => a.name === "CLAUDE.md");
    expect(memory).toBeDefined();
    expect(memory?.path).toBe(path.join(project, "CLAUDE.md"));
    expect(memory?.body).toContain("Project memory");
  });

  it("does not surface CLAUDE.md for skill or command types", async () => {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), "# memory\n");

    for (const type of ["skill", "command"] as const) {
      const out = await listClaudeArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
        tool: "claude",
        scope: "global",
        type,
      });
      expect(out.find((a) => a.name === "CLAUDE.md")).toBeUndefined();
    }
  });

  it("skips CLAUDE.md when the file is absent", async () => {
    const out = await listClaudeArtifacts(nodeFs, nodeJoiner, pathDeps(home), {
      tool: "claude",
      scope: "global",
      type: "agent",
    });
    expect(out.find((a) => a.name === "CLAUDE.md")).toBeUndefined();
  });
});

describe("CLAUDE.md backup and restore", () => {
  let tmp: string;
  let home: string;
  let project: string;
  let dest: string;

  beforeEach(async () => {
    resetHomeCache();
    tmp = await makeTmp("claude-md-backup");
    home = path.join(tmp, "home");
    project = path.join(tmp, "proj");
    dest = path.join(tmp, "drive");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(dest, { recursive: true });
  });

  afterEach(async () => {
    await rmrf(tmp);
  });

  it("mirrors ~/.claude/CLAUDE.md to <dest>/claude/global/agent/CLAUDE.md", async () => {
    const original = "# Personal\n\nPrefer functional style.\n";
    await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), original);

    const m = await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [],
    });

    const mirrored = await fs.readFile(
      path.join(dest, "claude", "global", "agent", "CLAUDE.md"),
      "utf8",
    );
    expect(mirrored).toBe(original);
    expect(m.entries.find((e) => e.relPath.endsWith("global/agent/CLAUDE.md"))).toBeDefined();
  });

  it("mirrors <project>/CLAUDE.md to <dest>/claude/project/<slug>/agent/CLAUDE.md", async () => {
    const original = "# Project context\n\nNo console.log in shipped code.\n";
    await fs.writeFile(path.join(project, "CLAUDE.md"), original);

    await runBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      destination: dest,
      tools: ["claude"],
      recentProjects: [project],
    });

    // Find the slugged project directory to read the mirrored file.
    const projectDirs = await fs.readdir(path.join(dest, "claude", "project"));
    expect(projectDirs.length).toBe(1);
    const mirrored = await fs.readFile(
      path.join(dest, "claude", "project", projectDirs[0], "agent", "CLAUDE.md"),
      "utf8",
    );
    expect(mirrored).toBe(original);
  });

  it("restoreFromBackup with relInItem=CLAUDE.md restores to ~/.claude/CLAUDE.md (not ~/.claude/agents/CLAUDE.md)", async () => {
    const original = "# Memory to restore\n";
    const backupSrc = path.join(dest, "claude", "global", "agent", "CLAUDE.md");
    await fs.mkdir(path.dirname(backupSrc), { recursive: true });
    await fs.writeFile(backupSrc, original);

    const result = await restoreFromBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      tool: "claude",
      scope: "global",
      type: "agent",
      files: [{ source: backupSrc, relInItem: "CLAUDE.md" }],
    });

    expect(result.written).toEqual([path.join(home, ".claude", "CLAUDE.md")]);
    const restored = await fs.readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(restored).toBe(original);
    // Confirm the file did NOT land in the agents subdir.
    const wrong = path.join(home, ".claude", "agents", "CLAUDE.md");
    await expect(fs.access(wrong)).rejects.toBeTruthy();
  });

  it("restoreFromBackup with relInItem=CLAUDE.md and project scope restores to <project>/CLAUDE.md", async () => {
    const original = "# Project memory to restore\n";
    const backupSrc = path.join(dest, "claude", "project", "slug", "agent", "CLAUDE.md");
    await fs.mkdir(path.dirname(backupSrc), { recursive: true });
    await fs.writeFile(backupSrc, original);

    const result = await restoreFromBackup({
      fs: nodeFs,
      paths: pathDeps(home),
      joiner: nodeJoiner,
      tool: "claude",
      scope: "project",
      type: "agent",
      projectRoot: project,
      files: [{ source: backupSrc, relInItem: "CLAUDE.md" }],
    });

    expect(result.written).toEqual([path.join(project, "CLAUDE.md")]);
    const restored = await fs.readFile(path.join(project, "CLAUDE.md"), "utf8");
    expect(restored).toBe(original);
  });
});

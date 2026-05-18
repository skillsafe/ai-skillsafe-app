import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { installFromGit, parseGitSpec } from "../src/lib/skillsafe/gitInstall";
import { readGitSources, upsertGitSource, gitSourcesPath } from "../src/lib/skillsafe/gitSources";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

describe("parseGitSpec", () => {
  it("parses short form owner/repo", () => {
    expect(parseGitSpec("anthropics/skills")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: undefined,
      subpath: undefined,
    });
  });
  it("parses owner/repo@ref", () => {
    expect(parseGitSpec("anthropics/skills@v1.0.0")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "v1.0.0",
      subpath: undefined,
    });
  });
  it("parses owner/repo@ref:subpath", () => {
    expect(parseGitSpec("anthropics/skills@main:skills/test")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      subpath: "skills/test",
    });
  });
  it("parses GitHub URLs", () => {
    expect(parseGitSpec("https://github.com/anthropics/skills/tree/main/skills/foo")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      subpath: "skills/foo",
    });
  });
  it("rejects garbage", () => {
    expect(parseGitSpec("")).toBeNull();
    expect(parseGitSpec("nope")).toBeNull();
  });
});

describe("git-sources.json persistence", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("gitsrc");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("round-trips a source entry", async () => {
    const filePath = await gitSourcesPath(nodeJoiner, tmp);
    const initial = await readGitSources(nodeFs, filePath);
    expect(initial).toEqual({ version: 1, sources: {} });
    await upsertGitSource(nodeFs, nodeJoiner, filePath, "demo", {
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      pinned: false,
      commit: "abc123",
      tool: "claude",
      scope: "global",
      targetDir: path.join(tmp, "demo"),
      installedHash: "deadbeef",
      installedAt: 1700000000000,
    });
    const reloaded = await readGitSources(nodeFs, filePath);
    expect(reloaded.sources.demo.owner).toBe("anthropics");
    expect(reloaded.sources.demo.commit).toBe("abc123");
  });
});

describe("installFromGit", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("gitinst");
  });
  afterEach(async () => {
    await rmrf(tmp);
    vi.unstubAllGlobals();
  });

  it("downloads a zipball, extracts a SKILL.md bundle, returns provenance", async () => {
    // Synthesize a zip that looks like codeload output:
    //   <repo>-<sha>/SKILL.md
    //   <repo>-<sha>/sub/note.md
    const zip = zipSync({
      "skills-abc/SKILL.md": strToU8("---\nname: demo\n---\nbody\n"),
      "skills-abc/sub/note.md": strToU8("hi\n"),
    });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.includes("codeload.github.com")) {
        return new Response(zip, { status: 200 });
      }
      if (s.includes("api.github.com/repos/anthropics/skills/git/refs/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "abc" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Default 404 so non-matching refs paths don't accidentally succeed.
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const deps = pathDeps(tmp);
    const result = await installFromGit(nodeFs, deps, nodeJoiner, {
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      pin: false,
      tool: "claude",
      scope: "global",
    });

    expect(result.owner).toBe("anthropics");
    expect(result.bundles.length).toBe(1);
    const bundle = result.bundles[0];
    expect(bundle.name).toBe("skills");
    expect(bundle.entries).toContain("SKILL.md");
    expect(bundle.entries).toContain("sub/note.md");
    const skillMd = await fs.readFile(path.join(bundle.targetDir, "SKILL.md"), "utf8");
    expect(skillMd).toContain("name: demo");
  });

  it("filters by subpath when multiple SKILL.md exist", async () => {
    const zip = zipSync({
      "skills-abc/skills/a/SKILL.md": strToU8("---\nname: a\n---\n"),
      "skills-abc/skills/b/SKILL.md": strToU8("---\nname: b\n---\n"),
    });
    const fetchMock = vi.fn(async () => new Response(zip, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const deps = pathDeps(tmp);
    const result = await installFromGit(nodeFs, deps, nodeJoiner, {
      owner: "x",
      repo: "y",
      ref: "main",
      subpath: "skills/b",
      tool: "claude",
      scope: "global",
    });
    expect(result.bundles.map((b) => b.name)).toEqual(["b"]);
  });
});

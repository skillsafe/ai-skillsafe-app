import { describe, expect, it } from "vitest";
import { installSet, refKey } from "../src/lib/skillsafe/installSet";
import { parseSkillSetManifest } from "../src/lib/skillsafe/sets";
import { nodeFs, nodeJoiner, pathDeps } from "./_helpers";

const manifest = parseSkillSetManifest({
  ns: "skillsafe",
  name: "starter",
  version: "0.1.0",
  description: "starter set",
  skills: [
    { ns: "skillsafe", name: "alpha", version: "1.0.0" },
    { ns: "skillsafe", name: "beta", version: "0.2.1" },
    { ns: "skillsafe", name: "gamma", version: "0.5.0", optional: true },
  ],
});

describe("installSet", () => {
  it("calls installSkill once per ref in manifest order", async () => {
    const calls: string[] = [];
    const result = await installSet({
      apiKey: null,
      manifest,
      tool: "claude",
      scope: "global",
      installSkill: async (o) => {
        calls.push(`${o.ns}/${o.name}@${o.version}`);
        return { targetDir: "/tmp/x", entries: [] };
      },
      fs: nodeFs,
      paths: pathDeps("/tmp"),
      joiner: nodeJoiner,
    });
    expect(calls).toEqual([
      "skillsafe/alpha@1.0.0",
      "skillsafe/beta@0.2.1",
      "skillsafe/gamma@0.5.0",
    ]);
    expect(result.installed).toHaveLength(3);
    expect(result.failed).toEqual([]);
  });

  it("collects non-optional failures, marks optional failures as skipped, keeps going", async () => {
    const result = await installSet({
      apiKey: null,
      manifest,
      tool: "claude",
      scope: "global",
      installSkill: async (o) => {
        if (o.name === "beta") throw new Error("boom");
        if (o.name === "gamma") throw new Error("optional fail");
        return { targetDir: "/tmp/x", entries: [] };
      },
      fs: nodeFs,
      paths: pathDeps("/tmp"),
      joiner: nodeJoiner,
    });
    expect(result.installed.map(refKey)).toEqual(["skillsafe/alpha"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].ref.name).toBe("beta");
    expect(result.skipped.map(refKey)).toEqual(["skillsafe/gamma"]);
  });

  it("respects the `selected` filter", async () => {
    const calls: string[] = [];
    await installSet({
      apiKey: null,
      manifest,
      selected: new Set(["skillsafe/alpha"]),
      tool: "claude",
      scope: "global",
      installSkill: async (o) => {
        calls.push(o.name);
        return { targetDir: "/tmp/x", entries: [] };
      },
      fs: nodeFs,
      paths: pathDeps("/tmp"),
      joiner: nodeJoiner,
    });
    expect(calls).toEqual(["alpha"]);
  });

  it("emits start/skill-*/done progress events", async () => {
    const events: string[] = [];
    await installSet({
      apiKey: null,
      manifest: parseSkillSetManifest({
        ns: "x",
        name: "y",
        version: "1",
        skills: [{ ns: "a", name: "b", version: "1" }],
      }),
      tool: "claude",
      scope: "global",
      installSkill: async () => ({ targetDir: "/tmp/x", entries: [] }),
      fs: nodeFs,
      paths: pathDeps("/tmp"),
      joiner: nodeJoiner,
      onProgress: (e) => events.push(e.kind),
    });
    expect(events).toEqual(["start", "skill-start", "skill-ok", "done"]);
  });
});

describe("parseSkillSetManifest", () => {
  it("rejects manifest with empty skills list", () => {
    expect(() =>
      parseSkillSetManifest({ ns: "x", name: "y", version: "1", skills: [] }),
    ).toThrow();
  });

  it("rejects skill ref missing version", () => {
    expect(() =>
      parseSkillSetManifest({
        ns: "x",
        name: "y",
        version: "1",
        skills: [{ ns: "a", name: "b" }],
      }),
    ).toThrow();
  });
});

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeBundleHash, detectDrift, readLockfile, writeLockfile } from "../src/lib/lockfile";
import { createSkillBundle, saveSkillBundle } from "../src/lib/artifacts/skill";
import { makeTmp, nodeFs, nodeJoiner, rmrf } from "./_helpers";

describe("lockfile", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("lock");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("reads and validates the v1 schema", async () => {
    const lockPath = path.join(tmp, "skills-lock.json");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        skills: {
          foo: { source: "api.example.com", sourceType: "well-known", computedHash: "abc" },
        },
      }),
    );
    const lock = await readLockfile(nodeFs, lockPath);
    expect(lock?.skills.foo.computedHash).toBe("abc");
  });

  it("detects drift when bundle is edited locally", async () => {
    const created = await createSkillBundle(
      nodeFs,
      nodeJoiner,
      tmp,
      "drifty",
      "test",
      "claude",
      "project",
    );
    const initialHash = await computeBundleHash(nodeFs, nodeJoiner, created.bundleDir!);
    const lock = {
      version: 1 as const,
      skills: {
        drifty: {
          source: "x",
          sourceType: "well-known",
          computedHash: initialHash,
        },
      },
    };
    let reports = await detectDrift(nodeFs, nodeJoiner, lock, async () => created.bundleDir!);
    expect(reports[0].drift).toBe(false);

    await saveSkillBundle(nodeFs, nodeJoiner, { ...created, body: "edited\n" });
    reports = await detectDrift(nodeFs, nodeJoiner, lock, async () => created.bundleDir!);
    expect(reports[0].drift).toBe(true);
  });

  it("writeLockfile round-trips through readLockfile", async () => {
    const lockPath = path.join(tmp, "skills-lock.json");
    const lock = {
      version: 1 as const,
      skills: {
        zeta: { source: "api.example.com", sourceType: "well-known", computedHash: "h2" },
        alpha: { source: "api.example.com", sourceType: "well-known", computedHash: "h1" },
      },
    };
    await writeLockfile(nodeFs, nodeJoiner, lockPath, lock);
    const back = await readLockfile(nodeFs, lockPath);
    expect(back).toEqual(lock);
    // Canonical: keys sorted, so alpha precedes zeta in the file.
    const raw = await fs.readFile(lockPath, "utf8");
    expect(raw.indexOf("alpha")).toBeLessThan(raw.indexOf("zeta"));
  });

  it("writeLockfile creates parent directories", async () => {
    const lockPath = path.join(tmp, "nested", "dir", "skills-lock.json");
    await writeLockfile(nodeFs, nodeJoiner, lockPath, {
      version: 1,
      skills: { foo: { source: "x", sourceType: "y", computedHash: "z" } },
    });
    expect(await fs.readFile(lockPath, "utf8")).toContain('"foo"');
  });
});

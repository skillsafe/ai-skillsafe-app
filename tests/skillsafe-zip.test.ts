import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { makeTmp, rmrf, nodeFs, nodeJoiner } from "./_helpers";
import { packSkillBundle, extractIntoDir } from "../src/lib/skillsafe/zip";

describe("skillsafe zip helpers", () => {
  it("round-trips a skill bundle through pack + extract", async () => {
    const tmp = await makeTmp("ss-zip");
    try {
      const src = path.join(tmp, "src");
      await fs.mkdir(path.join(src, "scripts"), { recursive: true });
      await fs.writeFile(path.join(src, "SKILL.md"), "---\nname: demo\n---\nbody");
      await fs.writeFile(path.join(src, "scripts", "run.sh"), "#!/bin/sh\necho hi");

      const archive = await packSkillBundle(nodeFs, nodeJoiner, src);
      expect(archive.byteLength).toBeGreaterThan(0);

      const dest = path.join(tmp, "dest");
      const written = await extractIntoDir(nodeFs, nodeJoiner, archive, dest);
      expect(written.sort()).toEqual(["SKILL.md", "scripts/run.sh"]);

      const skill = await fs.readFile(path.join(dest, "SKILL.md"), "utf8");
      expect(skill).toContain("name: demo");
      const script = await fs.readFile(path.join(dest, "scripts", "run.sh"), "utf8");
      expect(script).toContain("echo hi");
    } finally {
      await rmrf(tmp);
    }
  });

  it("rejects archives with parent-dir traversal", async () => {
    const { zipSync } = await import("fflate");
    const malicious = zipSync({ "../escape.txt": new TextEncoder().encode("bad") });
    const tmp = await makeTmp("ss-zip-bad");
    try {
      await expect(extractIntoDir(nodeFs, nodeJoiner, malicious, path.join(tmp, "out"))).rejects.toThrow(/unsafe/i);
    } finally {
      await rmrf(tmp);
    }
  });

  it("skips dotfiles at the bundle root when packing", async () => {
    const tmp = await makeTmp("ss-zip-dot");
    try {
      const src = path.join(tmp, "src");
      await fs.mkdir(src, { recursive: true });
      await fs.writeFile(path.join(src, "SKILL.md"), "x");
      await fs.writeFile(path.join(src, ".DS_Store"), "junk");

      const archive = await packSkillBundle(nodeFs, nodeJoiner, src);
      const { unzipSync } = await import("fflate");
      const entries = Object.keys(unzipSync(archive));
      expect(entries).toContain("SKILL.md");
      expect(entries).not.toContain(".DS_Store");
    } finally {
      await rmrf(tmp);
    }
  });
});

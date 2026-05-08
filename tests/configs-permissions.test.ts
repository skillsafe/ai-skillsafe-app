import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSettings,
  saveSettings,
  settingsPath,
} from "../src/lib/configs/settingsJson";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

describe("configs/settingsJson", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("configs");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("returns an empty doc when settings.json doesn't exist", async () => {
    const target = path.join(tmp, ".claude", "settings.json");
    const doc = await loadSettings(nodeFs, target);
    expect(doc.exists).toBe(false);
    expect(doc.permissions).toEqual({});
    expect(doc.rest).toEqual({});
  });

  it("preserves unknown top-level keys across save", async () => {
    const target = path.join(tmp, ".claude", "settings.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      JSON.stringify(
        {
          permissions: { allow: ["Bash(git status)"], defaultMode: "auto" },
          statusLine: { type: "command", command: "echo hi" },
          theme: "dark",
          effortLevel: "high",
        },
        null,
        2,
      ),
    );

    const doc = await loadSettings(nodeFs, target);
    const saved = await saveSettings(nodeFs, nodeJoiner, doc, {
      permissions: {
        allow: ["Bash(git status)", "Bash(ls)"],
        defaultMode: "auto",
      },
    });

    const onDisk = JSON.parse(await fs.readFile(saved.path, "utf8"));
    expect(onDisk.statusLine).toEqual({ type: "command", command: "echo hi" });
    expect(onDisk.theme).toBe("dark");
    expect(onDisk.effortLevel).toBe("high");
    expect(onDisk.permissions.allow).toEqual([
      "Bash(git status)",
      "Bash(ls)",
    ]);
  });

  it("does not write empty arrays for unset buckets", async () => {
    const target = path.join(tmp, ".claude", "settings.json");
    const doc = await loadSettings(nodeFs, target);
    const saved = await saveSettings(nodeFs, nodeJoiner, doc, {
      permissions: { allow: ["Bash(ls)"] },
    });
    const onDisk = JSON.parse(await fs.readFile(saved.path, "utf8"));
    expect(onDisk.permissions.deny).toBeUndefined();
    expect(onDisk.permissions.ask).toBeUndefined();
  });

  it("settingsPath resolves global vs project (local/shared)", async () => {
    const home = tmp;
    const proj = path.join(tmp, "proj");
    const global = await settingsPath(nodeJoiner, pathDeps(home), "global", null, "local");
    expect(global).toBe(path.join(home, ".claude", "settings.json"));

    const projLocal = await settingsPath(nodeJoiner, pathDeps(home), "project", proj, "local");
    expect(projLocal).toBe(path.join(proj, ".claude", "settings.local.json"));

    const projShared = await settingsPath(nodeJoiner, pathDeps(home), "project", proj, "shared");
    expect(projShared).toBe(path.join(proj, ".claude", "settings.json"));

    const noProject = await settingsPath(nodeJoiner, pathDeps(home), "project", null, "local");
    expect(noProject).toBeNull();
  });

  it("ignores malformed JSON gracefully", async () => {
    const target = path.join(tmp, ".claude", "settings.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "{ broken json,,,, ");
    const doc = await loadSettings(nodeFs, target);
    expect(doc.exists).toBe(true);
    expect(doc.permissions).toEqual({});
  });
});

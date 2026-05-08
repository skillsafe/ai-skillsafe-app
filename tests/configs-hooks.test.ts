import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coalesceHooks as coalesce } from "../src/lib/configs/hooksRows";
import {
  loadSettings,
  saveSettings,
} from "../src/lib/configs/settingsJson";
import { makeTmp, nodeFs, nodeJoiner, rmrf } from "./_helpers";

describe("HooksEditor.coalesce", () => {
  it("groups rows by (event, matcher)", () => {
    const out = coalesce([
      { event: "PreToolUse", matcher: "Bash", command: "echo a" },
      { event: "PreToolUse", matcher: "Bash", command: "echo b" },
      { event: "PreToolUse", matcher: "", command: "echo c" },
      { event: "Stop", matcher: "", command: "echo d", timeout: 5 },
    ]);
    expect(out).toEqual({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "echo a" },
            { type: "command", command: "echo b" },
          ],
        },
        {
          matcher: undefined,
          hooks: [{ type: "command", command: "echo c" }],
        },
      ],
      Stop: [
        {
          matcher: undefined,
          hooks: [{ type: "command", command: "echo d", timeout: 5 }],
        },
      ],
    });
  });

  it("drops rows with empty commands", () => {
    const out = coalesce([
      { event: "PreToolUse", matcher: "Bash", command: "" },
      { event: "PreToolUse", matcher: "Bash", command: "  " },
    ]);
    expect(out).toEqual({});
  });
});

describe("settings.json hooks round-trip", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("hooks");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("writes the documented shape and re-reads it", async () => {
    const target = path.join(tmp, ".claude", "settings.json");
    const initial = await loadSettings(nodeFs, target);
    const saved = await saveSettings(nodeFs, nodeJoiner, initial, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo hi" }],
          },
        ],
      },
    });
    const onDisk = JSON.parse(await fs.readFile(saved.path, "utf8"));
    expect(onDisk.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(onDisk.hooks.PreToolUse[0].hooks[0]).toEqual({
      type: "command",
      command: "echo hi",
    });

    const reloaded = await loadSettings(nodeFs, saved.path);
    expect(reloaded.hooks).toEqual(saved.hooks);
  });

  it("dropping every hook removes the hooks key entirely", async () => {
    const target = path.join(tmp, ".claude", "settings.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }],
        },
        theme: "dark",
      }),
    );
    const doc = await loadSettings(nodeFs, target);
    const saved = await saveSettings(nodeFs, nodeJoiner, doc, { hooks: {} });
    const onDisk = JSON.parse(await fs.readFile(saved.path, "utf8"));
    expect(onDisk.hooks).toBeUndefined();
    expect(onDisk.theme).toBe("dark");
    expect(onDisk.permissions.allow).toEqual(["Bash(ls)"]);
  });
});

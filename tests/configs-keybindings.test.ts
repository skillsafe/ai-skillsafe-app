import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadKeybindings,
  saveKeybindings,
  saveKeybindingsRaw,
} from "../src/lib/configs/keybindings";
import { makeTmp, nodeFs, rmrf } from "./_helpers";

describe("configs/keybindings", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("kb");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("returns empty doc when file is absent", async () => {
    const target = path.join(tmp, ".claude", "keybindings.json");
    const doc = await loadKeybindings(nodeFs, target);
    expect(doc.exists).toBe(false);
    expect(doc.bindings).toEqual([]);
  });

  it("first save creates the file", async () => {
    const target = path.join(tmp, ".claude", "keybindings.json");
    const doc = await loadKeybindings(nodeFs, target);
    const saved = await saveKeybindings(nodeFs, doc, [
      { action: "save", keys: "ctrl+s" },
    ]);
    expect(saved.exists).toBe(true);
    const onDisk = JSON.parse(await fs.readFile(saved.path, "utf8"));
    expect(onDisk.bindings).toEqual([{ action: "save", keys: "ctrl+s" }]);
  });

  it("preserves unknown top-level keys via form save", async () => {
    const target = path.join(tmp, ".claude", "keybindings.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      JSON.stringify({
        bindings: [{ action: "save", keys: "ctrl+s" }],
        $schema: "https://example.com/keybindings.schema.json",
        custom: { nested: 1 },
      }),
    );
    const doc = await loadKeybindings(nodeFs, target);
    const saved = await saveKeybindings(nodeFs, doc, [
      { action: "quit", keys: "ctrl+q" },
    ]);
    const onDisk = JSON.parse(await fs.readFile(saved.path, "utf8"));
    expect(onDisk.$schema).toBe("https://example.com/keybindings.schema.json");
    expect(onDisk.custom).toEqual({ nested: 1 });
    expect(onDisk.bindings).toEqual([{ action: "quit", keys: "ctrl+q" }]);
  });

  it("Raw JSON save round-trips lossless including unknown keys", async () => {
    const target = path.join(tmp, ".claude", "keybindings.json");
    const raw = JSON.stringify(
      {
        $schema: "x",
        somethingNew: { foo: "bar" },
        bindings: [{ action: "x", keys: "y", custom: 42 }],
      },
      null,
      2,
    );
    const saved = await saveKeybindingsRaw(nodeFs, target, raw);
    const reloaded = await loadKeybindings(nodeFs, saved.path);
    expect(JSON.parse(reloaded.rawText)).toEqual(JSON.parse(raw));
    // Form view also preserves the binding's unknown `custom: 42` field via
    // the passthrough schema.
    expect(reloaded.bindings[0]).toMatchObject({ action: "x", keys: "y", custom: 42 });
  });

  it("Raw JSON save rejects malformed input", async () => {
    const target = path.join(tmp, ".claude", "keybindings.json");
    await expect(
      saveKeybindingsRaw(nodeFs, target, "{ broken,, "),
    ).rejects.toBeTruthy();
  });
});

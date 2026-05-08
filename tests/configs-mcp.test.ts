import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcp, saveMcp } from "../src/lib/configs/mcp";
import { rowsToServers } from "../src/lib/configs/mcpRows";
import { makeTmp, nodeFs, rmrf } from "./_helpers";

describe("configs/mcp", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("mcp");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("round-trips stdio + url servers", async () => {
    const target = path.join(tmp, ".mcp.json");
    const initial = await loadMcp(nodeFs, target);
    const saved = await saveMcp(nodeFs, initial, [
      {
        name: "skillsafe",
        server: { type: "url", url: "https://api.skillsafe.ai/mcp" },
      },
      {
        name: "filesystem",
        server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      },
    ]);

    const onDisk = JSON.parse(await fs.readFile(saved.path, "utf8"));
    expect(onDisk.mcpServers.skillsafe).toEqual({
      type: "url",
      url: "https://api.skillsafe.ai/mcp",
    });
    expect(onDisk.mcpServers.filesystem.command).toBe("npx");

    const reloaded = await loadMcp(nodeFs, saved.path);
    expect(reloaded.servers.map((s) => s.name)).toEqual(["skillsafe", "filesystem"]);
  });

  it("preserves unknown sibling keys", async () => {
    const target = path.join(tmp, ".mcp.json");
    await fs.writeFile(
      target,
      JSON.stringify({
        mcpServers: { foo: { command: "node" } },
        $comment: "do not delete",
      }),
    );
    const doc = await loadMcp(nodeFs, target);
    const saved = await saveMcp(nodeFs, doc, [
      { name: "bar", server: { command: "ls" } },
    ]);
    const onDisk = JSON.parse(await fs.readFile(saved.path, "utf8"));
    expect(onDisk.$comment).toBe("do not delete");
    expect(onDisk.mcpServers).toEqual({ bar: { command: "ls" } });
  });

  it("removing every server drops the mcpServers key entirely", async () => {
    const target = path.join(tmp, ".mcp.json");
    await fs.writeFile(
      target,
      JSON.stringify({
        mcpServers: { foo: { command: "node" } },
        other: 1,
      }),
    );
    const doc = await loadMcp(nodeFs, target);
    const saved = await saveMcp(nodeFs, doc, []);
    const onDisk = JSON.parse(await fs.readFile(saved.path, "utf8"));
    expect(onDisk.mcpServers).toBeUndefined();
    expect(onDisk.other).toBe(1);
  });
});

describe("McpEditor.rowsToServers", () => {
  it("parses stdio fields with args + env", () => {
    const out = rowsToServers([
      {
        name: "fs",
        transport: "stdio",
        command: "npx",
        args: "-y server-fs /tmp",
        env: "FOO=bar\nBAZ=qux",
      },
    ]);
    expect(out).toEqual([
      {
        name: "fs",
        server: {
          command: "npx",
          args: ["-y", "server-fs", "/tmp"],
          env: { FOO: "bar", BAZ: "qux" },
        },
      },
    ]);
  });

  it("parses url with optional headers", () => {
    const out = rowsToServers([
      {
        name: "remote",
        transport: "url",
        url: "https://x.example/mcp",
        headers: "Authorization: Bearer abc\nX-Trace: 1",
      },
    ]);
    expect(out).toEqual([
      {
        name: "remote",
        server: {
          type: "url",
          url: "https://x.example/mcp",
          headers: { Authorization: "Bearer abc", "X-Trace": "1" },
        },
      },
    ]);
  });

  it("drops rows without a name or required transport field", () => {
    const out = rowsToServers([
      { name: "", transport: "stdio", command: "x" },
      { name: "x", transport: "stdio", command: "" },
      { name: "x", transport: "url", url: "" },
    ]);
    expect(out).toEqual([]);
  });
});

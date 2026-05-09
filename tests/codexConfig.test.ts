import { describe, expect, it } from "vitest";
import {
  parseCodexMcp,
  removeCodexMcp,
  serializeCodexMcp,
  upsertCodexMcp,
} from "../src/lib/configs/codexConfig";

describe("codexConfig parser", () => {
  it("parses a single mcp_servers section with command/args", () => {
    const raw = `
[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp", "--browser=chromium"]
`.trimStart();
    const doc = parseCodexMcp(raw);
    expect(doc.servers).toHaveLength(1);
    const { name, server } = doc.servers[0];
    expect(name).toBe("playwright");
    expect("command" in server && server.command).toBe("npx");
    expect("args" in server ? server.args : null).toEqual([
      "@playwright/mcp",
      "--browser=chromium",
    ]);
  });

  it("merges env from a sibling [mcp_servers.<name>.env] section", () => {
    const raw = `
[mcp_servers.weather]
command = "node"
args = ["server.js"]

[mcp_servers.weather.env]
API_KEY = "abc"
DEBUG = "1"
`.trimStart();
    const doc = parseCodexMcp(raw);
    const { server } = doc.servers[0];
    expect("env" in server ? server.env : null).toEqual({ API_KEY: "abc", DEBUG: "1" });
  });

  it("preserves non-mcp_servers content as `rest` for round-trip", () => {
    const raw = `# top of file
default_model = "gpt-4"

[some_other_section]
foo = "bar"

[mcp_servers.playwright]
command = "npx"
`.trimStart();
    const doc = parseCodexMcp(raw);
    expect(doc.rest).toContain('default_model = "gpt-4"');
    expect(doc.rest).toContain("[some_other_section]");
    expect(doc.rest).toContain('foo = "bar"');
    expect(doc.rest).not.toContain("mcp_servers");
  });

  it("supports HTTP/SSE servers with `url` + headers", () => {
    const raw = `
[mcp_servers.web]
type = "url"
url = "https://example.com/mcp"

[mcp_servers.web.headers]
X-Auth = "tok"
`.trimStart();
    const doc = parseCodexMcp(raw);
    const { server } = doc.servers[0];
    expect("url" in server && server.url).toBe("https://example.com/mcp");
    expect("headers" in server ? server.headers : null).toEqual({ "X-Auth": "tok" });
  });

  it("upsertCodexMcp inserts a new server while preserving existing siblings + rest", () => {
    const raw = `
default_model = "gpt-4"

[mcp_servers.existing]
command = "node"
args = ["a.js"]
`.trimStart();
    const { content } = upsertCodexMcp(raw, "newone", {
      command: "npx",
      args: ["@scope/mcp"],
    });
    expect(content).toContain('default_model = "gpt-4"');
    expect(content).toContain("[mcp_servers.existing]");
    expect(content).toContain('command = "node"');
    expect(content).toContain("[mcp_servers.newone]");
    expect(content).toContain('command = "npx"');
  });

  it("upsertCodexMcp replaces an existing server in place", () => {
    const raw = `
[mcp_servers.playwright]
command = "old"
args = ["x"]
`.trimStart();
    const { content } = upsertCodexMcp(raw, "playwright", {
      command: "npx",
      args: ["@playwright/mcp"],
    });
    expect(content).not.toContain('command = "old"');
    expect(content).toContain('command = "npx"');
    expect(content.match(/\[mcp_servers\.playwright\]/g)).toHaveLength(1);
  });

  it("removeCodexMcp drops a server while preserving siblings + rest", () => {
    const raw = `
default_model = "gpt-4"

[mcp_servers.keep]
command = "node"

[mcp_servers.drop]
command = "old"
`.trimStart();
    const { content } = removeCodexMcp(raw, "drop");
    expect(content).toContain("[mcp_servers.keep]");
    expect(content).not.toContain("[mcp_servers.drop]");
    expect(content).toContain('default_model = "gpt-4"');
  });

  it("escapes special characters when serializing", () => {
    const out = serializeCodexMcp(
      { rawSource: "", rest: "", servers: [] },
      [
        {
          name: "tricky",
          server: {
            command: 'a "quoted" path',
            args: ["one", 'two with "quote"'],
            env: { KEY: 'val with "quote"' },
          },
        },
      ],
    );
    expect(out).toContain('command = "a \\"quoted\\" path"');
    expect(out).toContain('args = ["one", "two with \\"quote\\""]');
    expect(out).toContain('KEY = "val with \\"quote\\""');
  });
});

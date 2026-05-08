import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanTranscriptsForRules } from "../src/lib/configs/transcriptScan";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

function jsonl(...messages: object[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
}

function bashUse(command: string): object {
  return {
    type: "user",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Bash", input: { command } },
      ],
    },
  };
}

describe("configs/transcriptScan", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("transcripts");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("returns empty when no projects directory exists", async () => {
    const out = await scanTranscriptsForRules(nodeFs, nodeJoiner, pathDeps(tmp));
    expect(out).toEqual([]);
  });

  it("aggregates Bash commands across multiple jsonl files into ranked rules", async () => {
    const projects = path.join(tmp, ".claude", "projects");
    const a = path.join(projects, "proj-a");
    const b = path.join(projects, "proj-b");
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });

    await fs.writeFile(
      path.join(a, "session1.jsonl"),
      jsonl(
        bashUse("git status"),
        bashUse("git status"),
        bashUse("git status"),
        bashUse("git diff"),
        bashUse("npm install"),
      ),
    );
    await fs.writeFile(
      path.join(b, "session2.jsonl"),
      jsonl(bashUse("git diff HEAD~1"), bashUse("ls -la"), bashUse("ls")),
    );

    const out = await scanTranscriptsForRules(nodeFs, nodeJoiner, pathDeps(tmp));
    // Top result should be the exact-match for the 3x-repeated command.
    expect(out[0]?.rule).toBe("Bash(git status)");
    expect(out[0]?.count).toBe(3);

    // git diff appeared twice with different args → glob fallback.
    expect(out.some((r) => r.rule === "Bash(git diff:*)")).toBe(true);
    // ls appeared twice → glob fallback at the program level.
    expect(out.some((r) => r.rule === "Bash(ls:*)")).toBe(true);
  });

  it("ignores non-Bash tool uses and malformed lines", async () => {
    const a = path.join(tmp, ".claude", "projects", "proj-a");
    await fs.mkdir(a, { recursive: true });
    await fs.writeFile(
      path.join(a, "session.jsonl"),
      [
        "not json",
        JSON.stringify({ type: "user", message: {} }),
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "tool_use", name: "Read", input: { path: "/etc" } }],
          },
        }),
        JSON.stringify(bashUse("git status")),
        JSON.stringify(bashUse("git status")),
        JSON.stringify(bashUse("git status")),
        "",
      ].join("\n"),
    );
    const out = await scanTranscriptsForRules(nodeFs, nodeJoiner, pathDeps(tmp));
    expect(out.find((r) => r.rule === "Bash(git status)")?.count).toBe(3);
    expect(out.every((r) => r.rule.startsWith("Bash("))).toBe(true);
  });
});

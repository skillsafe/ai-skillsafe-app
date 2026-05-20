import { describe, expect, it } from "vitest";
import {
  generateSessionStartHook,
  mergeHookIntoSettings,
  renderCommand,
} from "../src/lib/hooks/sessionStartGen";

describe("sessionStart hook generator", () => {
  it("renders a command that greps for the quarantine sentinel", () => {
    const cmd = renderCommand({ globalSkillsDir: "/Users/x/.claude/skills" });
    expect(cmd).toContain("status: quarantined");
    expect(cmd).toContain("'/Users/x/.claude/skills'");
    expect(cmd).toContain("exit 2");
  });

  it("includes project skill paths when projectRoot is set", () => {
    const cmd = renderCommand({
      globalSkillsDir: "/Users/x/.claude/skills",
      projectRoot: "/Users/x/proj",
    });
    expect(cmd).toContain("'/Users/x/proj/.claude/skills'");
    expect(cmd).toContain("'/Users/x/proj/.agents/skills'");
  });

  it("shell-escapes single quotes in paths", () => {
    const cmd = renderCommand({ globalSkillsDir: "/Users/x's tools/.claude/skills" });
    // Standard POSIX idiom: close, escape, reopen.
    expect(cmd).toContain("/Users/x'\\''s tools/.claude/skills");
  });

  it("emits a Claude Code SessionStart hook shape", () => {
    const entry = generateSessionStartHook({ globalSkillsDir: "/home/x/.claude/skills" });
    expect(entry.SessionStart).toHaveLength(1);
    const block = entry.SessionStart[0];
    expect(block.matcher).toBe("*");
    expect(block.hooks[0].type).toBe("command");
    expect(block.hooks[0].timeout).toBe(5);
    expect(block.hooks[0].command).toContain("status: quarantined");
  });

  it("merge preserves unrelated SessionStart blocks", () => {
    const settings = {
      SessionStart: [
        { matcher: "*", hooks: [{ type: "command", command: "echo hi" }] },
      ],
    };
    const entry = generateSessionStartHook({ globalSkillsDir: "/x" });
    const merged = mergeHookIntoSettings(settings, entry);
    const list = merged.SessionStart as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list[0].hooks).toEqual([{ type: "command", command: "echo hi" }]);
    expect(list[1].skillsafe_id).toBe("quarantine-gate");
  });

  it("merge is idempotent — second call replaces our prior block", () => {
    const settings = {};
    const entry = generateSessionStartHook({ globalSkillsDir: "/x" });
    const once = mergeHookIntoSettings(settings, entry);
    const twice = mergeHookIntoSettings(once, entry);
    const list = twice.SessionStart as unknown[];
    expect(list).toHaveLength(1);
  });

  it("merge preserves other settings keys", () => {
    const settings: Record<string, unknown> = { theme: "dark", autoUpdate: true };
    const entry = generateSessionStartHook({ globalSkillsDir: "/x" });
    const merged = mergeHookIntoSettings(settings, entry);
    expect(merged.theme).toBe("dark");
    expect(merged.autoUpdate).toBe(true);
  });
});

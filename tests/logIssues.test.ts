import { describe, expect, it } from "vitest";
import { detectLogIssues } from "../src/lib/backup/logIssues";

describe("detectLogIssues", () => {
  it("returns no issues for a clean log", () => {
    const text = [
      "[2026-05-14 09:26:56] [1/12] Sync Claude Code · Skills ...",
      "[2026-05-14 09:26:56] [1/12] OK (1.3M)",
    ].join("\n");
    expect(detectLogIssues(text)).toEqual([]);
  });

  it("extracts the destination dir from a TCC EPERM rsync error", () => {
    const text = [
      "[2026-05-14 09:07:44] [1/12] Sync Claude Code · Skills ...",
      "rsync(33997): error: /Users/xhu/Library/CloudStorage/OneDrive-X/Personal Backup/skillsafe/claude/skills/: open: Operation not permitted",
      "[2026-05-14 09:07:44] [1/12] FAILED",
    ].join("\n");
    const issues = detectLogIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("tcc-cloudstorage-eperm");
    expect(issues[0].paths).toEqual([
      "/Users/xhu/Library/CloudStorage/OneDrive-X/Personal Backup/skillsafe/claude/skills/",
    ]);
    expect(issues[0].occurredAt).toBe(Date.parse("2026-05-14T09:07:44"));
  });

  it("deduplicates repeated paths but preserves distinct ones", () => {
    const text = [
      "rsync: error: /Users/x/Library/CloudStorage/A/foo/: open: Operation not permitted",
      "rsync: error: /Users/x/Library/CloudStorage/A/foo/: open: Operation not permitted",
      "rsync: error: /Users/x/Library/CloudStorage/A/bar/: open: Operation not permitted",
    ].join("\n");
    const issues = detectLogIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0].paths).toEqual([
      "/Users/x/Library/CloudStorage/A/bar/",
      "/Users/x/Library/CloudStorage/A/foo/",
    ]);
  });

  it("ignores EPERM on non-CloudStorage paths", () => {
    const text = "rsync: error: /tmp/foo/: open: Operation not permitted";
    expect(detectLogIssues(text)).toEqual([]);
  });

  it("ignores other rsync errors on CloudStorage paths", () => {
    const text =
      "rsync: error: /Users/x/Library/CloudStorage/A/foo/: read: I/O error";
    expect(detectLogIssues(text)).toEqual([]);
  });
});

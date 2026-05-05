import { describe, it, expect } from "vitest";
import { __testing } from "../src/lib/backup/generateScripts";

const opts = {
  home: "/Users/xhu",
  joiner: { join: async (...p: string[]) => p.join("/") },
} as never;

describe("script tool sections", () => {
  it("normalizes empty/undefined to default ['claude'], drops unknown ids", () => {
    expect(__testing.normalizeTools(undefined)).toEqual(["claude"]);
    expect(__testing.normalizeTools([])).toEqual(["claude"]);
    expect(__testing.normalizeTools(["bogus"])).toEqual([]);
  });

  it("expands default-enabled data types when no per-tool selection given", async () => {
    const tools = __testing.normalizeTools(["claude"]);
    const sections = await __testing.resolveSections(opts, tools, undefined);
    const ids = sections.map((s) => s.dataType.id);
    // skills/commands/agents/plugins/memory/settings/desktop-config are
    // defaultEnabled; tasks-plans/history are not.
    expect(ids).toContain("skills");
    expect(ids).toContain("memory");
    expect(ids).toContain("settings");
    expect(ids).toContain("desktop-config");
    expect(ids).not.toContain("history");
    expect(ids).not.toContain("tasks-plans");
  });

  it("respects per-tool data-type selection", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["skills", "commands"] },
    );
    expect(sections.map((s) => s.dataType.id)).toEqual(["skills", "commands"]);
    expect(sections.map((s) => s.destSubdir)).toEqual([
      "claude/skills",
      "claude/commands",
    ]);
  });

  it("flat-layouts tools with only the fallback 'all' data type", async () => {
    // codex now has explicit data types, so use a tool that doesn't.
    const sections = await __testing.resolveSections(opts, ["windsurf"], undefined);
    expect(sections).toHaveLength(1);
    expect(sections[0].destSubdir).toBe("windsurf");
    expect(sections[0].dataType.id).toBe("all");
  });

  it("derives configRoot as parent of globalSkillsDir", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["codex"],
      { codex: ["prompts"] },
    );
    expect(sections[0].configRoot).toBe("/Users/xhu/.codex");
  });

  it("renders bash sections with --copy-unsafe-links so external symlinks become real files", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["skills"] },
    );
    const out = __testing.renderBashSections(sections);
    expect(out).toContain("--copy-unsafe-links");
    expect(out).toContain('mkdir -p "$MIRROR/claude/skills"');
  });

  it("uses --inplace so OneDrive/iCloud destinations don't fail on renameat", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["skills", "settings", "desktop-config"] },
    );
    const out = __testing.renderBashSections(sections);
    // Every rsync invocation should carry --inplace.
    const rsyncLines = out.split("\n").filter((l) => l.includes("rsync "));
    expect(rsyncLines.length).toBeGreaterThan(0);
    for (const l of rsyncLines) expect(l).toContain("--inplace");
  });

  it("includes --ignore-errors so --delete keeps running past broken symlinks", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["skills"] },
    );
    const out = __testing.renderBashSections(sections);
    expect(out).toContain("--ignore-errors");
  });

  it("explicitly removes the legacy nested layout for single-path tree types", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["skills"] },
    );
    const out = __testing.renderBashSections(sections);
    // After the migration runs, <dest>/claude/skills/skills (legacy) is gone
    // before rsync writes the new flat layout.
    expect(out).toMatch(/\[ -d "\$MIRROR\/claude\/skills\/skills" \] && rm -rf/);
  });

  it("excludes install-counts-cache.json (fetched cache, not user data)", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["plugins"] },
    );
    const out = __testing.renderBashSections(sections);
    expect(out).toContain("--exclude='install-counts-cache.json'");
    // --delete-excluded makes sure previously-mirrored cache files get
    // cleaned out of the destination once we add a new exclude.
    expect(out).toContain("--delete-excluded");
  });

  it("does NOT emit legacy cleanup for multi-path tree types (paths still nest)", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["tasks-plans"] },
    );
    const out = __testing.renderBashSections(sections);
    expect(out).not.toMatch(/rm -rf "\$MIRROR\/claude\/tasks-plans\/(tasks|plans)"/);
  });

  it("classifies rsync exit codes 23/24 as warnings, not failures", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["skills"] },
    );
    const out = __testing.renderBashSections(sections);
    expect(out).toContain("EC -eq 23");
    expect(out).toContain("EC -eq 24");
    expect(out).toContain("WARN=1");
    expect(out).toContain("OK with warnings");
  });

  it("emits the desktop-config section using $HOME paths, not the agent root", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["desktop-config"] },
    );
    const out = __testing.renderBashSections(sections);
    expect(out).toContain("$HOME/Library/Application Support/Claude/claude_desktop_config.json");
  });

  it("renders no-op message when nothing is selected", async () => {
    const sections = await __testing.resolveSections(opts, [], undefined);
    const out = __testing.renderBashSections(sections);
    expect(out).toBe('log "No tools selected — nothing to back up."');
  });

  it("excludes claude cache/telemetry only inside claude tree sections", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude", "cursor"],
      { claude: ["memory"], cursor: ["skills"] },
    );
    const out = __testing.renderBashSections(sections);
    const claudeBlock = out.split("Sync Cursor")[0];
    const cursorBlock = out.split("Sync Cursor").slice(1).join("Sync Cursor");
    expect(claudeBlock).toMatch(/--exclude='cache\/'/);
    expect(cursorBlock).not.toMatch(/--exclude='cache\/'/);
  });

  it("normalizeTools sorts and de-duplicates", () => {
    expect(__testing.normalizeTools(["cursor", "claude", "claude"])).toEqual([
      "claude",
      "cursor",
    ]);
  });

  it("accepts extra sources (e.g. shared-agents) alongside real tools", async () => {
    expect(__testing.normalizeTools(["claude", "shared-agents"])).toEqual([
      "claude",
      "shared-agents",
    ]);
    const sections = await __testing.resolveSections(
      opts,
      ["shared-agents"],
      undefined,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].configRoot).toBe("/Users/xhu/.agents");
    expect(sections[0].destSubdir).toBe("shared-agents");
    expect(sections[0].toolLabel).toMatch(/Shared agents/);
  });
});

describe("restore mappings", () => {
  it("flattens single-path tree types so backup <dest>/claude/skills/ ↔ live ~/.claude/skills/", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["skills"] },
    );
    const mappings = __testing.buildRestoreMappings(sections);
    expect(mappings).toHaveLength(1);
    // No inner /skills/ — destSubdir already names the slice.
    expect(mappings[0].src).toBe("$MIRROR/claude/skills/");
    expect(mappings[0].dst).toBe("/Users/xhu/.claude/skills/");
    expect(mappings[0].kind).toBe("dir");
  });

  it("nests multi-path tree types so paths don't collide", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["tasks-plans"] },
    );
    const mappings = __testing.buildRestoreMappings(sections);
    expect(mappings.map((m) => m.src)).toEqual([
      "$MIRROR/claude/tasks-plans/tasks/",
      "$MIRROR/claude/tasks-plans/plans/",
    ]);
  });

  it("expands files-kind data type into one mapping per file", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["settings"] },
    );
    const mappings = __testing.buildRestoreMappings(sections);
    expect(mappings.map((m) => m.src)).toEqual([
      "$MIRROR/claude/settings/settings.json",
      "$MIRROR/claude/settings/.mcp.json",
      "$MIRROR/claude/settings/CLAUDE.md",
      "$MIRROR/claude/settings/statusline-command.sh",
    ]);
    expect(mappings[0].dst).toBe("/Users/xhu/.claude/");
    expect(mappings[0].kind).toBe("file");
  });

  it("routes desktop-config back to ~/Library/Application Support/Claude/", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["desktop-config"] },
    );
    const mappings = __testing.buildRestoreMappings(sections);
    expect(mappings[0].src).toBe("$MIRROR/claude/desktop-config/claude_desktop_config.json");
    expect(mappings[0].dst).toBe("$HOME/Library/Application Support/Claude/");
    expect(mappings[0].kind).toBe("file");
  });

  it("uses flat layout for tools that only have the fallback 'all' data type", async () => {
    const sections = await __testing.resolveSections(opts, ["windsurf"], undefined);
    const mappings = __testing.buildRestoreMappings(sections);
    expect(mappings).toHaveLength(1);
    expect(mappings[0].src).toBe("$MIRROR/windsurf/");
    expect(mappings[0].dst).toBe("/Users/xhu/.codeium/windsurf/");
  });

  it("renders bash 'scan' calls per mapping", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["skills", "commands"] },
    );
    const out = __testing.renderBashRestoreSections(sections, "scan");
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("$MIRROR/claude/skills/");
    expect(out).toContain("/Users/xhu/.claude/skills/");
    expect(out).not.toContain("$MIRROR/claude/skills/skills/");
  });

  it("renders bash 'apply' calls with the same shape", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["plugins"] },
    );
    const out = __testing.renderBashRestoreSections(sections, "apply");
    expect(out).toMatch(/^apply ".*Plugins.*"/);
  });

  it("emits an empty/no-op restore section when nothing is selected", async () => {
    const sections = await __testing.resolveSections(opts, [], undefined);
    expect(__testing.renderBashRestoreSections(sections, "scan")).toContain(
      "(nothing to restore",
    );
    expect(__testing.renderBashRestoreSections(sections, "apply")).toBe("");
  });

  it("converts $HOME and $MIRROR to PowerShell vars in pwsh restore output", async () => {
    const sections = await __testing.resolveSections(
      opts,
      ["claude"],
      { claude: ["desktop-config", "skills"] },
    );
    const out = __testing.renderPwshRestoreSections(sections, "Scan");
    expect(out).toContain("$env:USERPROFILE");
    expect(out).toContain("$Mirror2");
    expect(out).not.toContain("$HOME");
    expect(out).not.toContain("$MIRROR");
    expect(out).toContain("\\Library\\Application Support\\Claude\\");
  });
});

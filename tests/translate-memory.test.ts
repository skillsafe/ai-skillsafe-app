import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseMemoryFor,
  previewMemoryTransfer,
  renderMemoryFor,
  resolveMemoryDestPath,
  transferMemory,
} from "../src/lib/translate/memory";
import { makeTmp, nodeFs, nodeJoiner, pathDeps, rmrf } from "./_helpers";

describe("translate/memory parse + render", () => {
  it("plain markdown round-trips through the IR for non-cursor tools", () => {
    const raw = "# memory\n\nbe terse.\n";
    const ir = parseMemoryFor("claude", raw);
    expect(ir.frontmatter).toEqual({});
    expect(ir.body).toBe(raw);
    expect(renderMemoryFor("codex", ir)).toBe(raw);
  });

  it("parses cursor MDC frontmatter into the IR and round-trips", () => {
    const raw = `---\ndescription: my rule\nalwaysApply: true\nglobs: ["**/*.ts"]\n---\n\n# body\n\nstuff\n`;
    const ir = parseMemoryFor("cursor", raw);
    expect(ir.frontmatter.description).toBe("my rule");
    expect(ir.frontmatter.alwaysApply).toBe(true);
    expect(ir.frontmatter.globs).toEqual(["**/*.ts"]);
    expect(ir.body.startsWith("# body")).toBe(true);
    const rendered = renderMemoryFor("cursor", ir);
    expect(rendered).toContain("description: my rule");
    expect(rendered).toContain("alwaysApply: true");
    expect(rendered).toContain("# body");
  });

  it("transferring plain markdown into cursor injects a description from the source name", () => {
    const out = previewMemoryTransfer({
      sourceTool: "claude",
      sourceName: "CLAUDE.md",
      sourceBody: "# personal memory\n\ndo stuff.\n",
      destTool: "cursor",
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("description: CLAUDE");
    expect(out).toContain("# personal memory");
  });

  it("transferring cursor → claude strips the MDC frontmatter, leaving plain body", () => {
    const out = previewMemoryTransfer({
      sourceTool: "cursor",
      sourceName: "rule.mdc",
      sourceBody: "---\ndescription: r\n---\n\n# body\n",
      destTool: "claude",
    });
    expect(out.startsWith("---")).toBe(false);
    expect(out).toContain("# body");
  });
});

describe("translate/memory destination paths", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("translate-dest");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("resolves claude/codex global memory to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md", async () => {
    const claudeDest = await resolveMemoryDestPath(nodeFs, pathDeps(tmp), nodeJoiner, {
      tool: "claude",
      scope: "global",
    });
    expect(claudeDest.path).toBe(path.join(tmp, ".claude", "CLAUDE.md"));
    expect(claudeDest.fixedSlot).toBe(true);

    const codexDest = await resolveMemoryDestPath(nodeFs, pathDeps(tmp), nodeJoiner, {
      tool: "codex",
      scope: "global",
    });
    expect(codexDest.path).toBe(path.join(tmp, ".codex", "AGENTS.md"));
  });

  it("cursor memory always falls back to project scope and lands under .cursor/rules/<slug>.mdc", async () => {
    const project = path.join(tmp, "proj");
    const dest = await resolveMemoryDestPath(nodeFs, pathDeps(tmp), nodeJoiner, {
      tool: "cursor",
      scope: "global", // intentionally global to confirm coercion
      projectRoot: project,
      fileName: "MY RULE.mdc",
    });
    expect(dest.path).toBe(path.join(project, ".cursor", "rules", "MY-RULE.mdc"));
    expect(dest.warnings.some((w) => w.toLowerCase().includes("global"))).toBe(true);
    expect(dest.fixedSlot).toBe(false);
  });

  it("cline picks .clinerules file when missing and a child .md when the dir exists", async () => {
    const project = path.join(tmp, "proj");
    await fs.mkdir(project, { recursive: true });

    // No .clinerules at all → single-file mode
    const single = await resolveMemoryDestPath(nodeFs, pathDeps(tmp), nodeJoiner, {
      tool: "cline",
      scope: "project",
      projectRoot: project,
    });
    expect(single.path).toBe(path.join(project, ".clinerules"));
    expect(single.fixedSlot).toBe(true);

    // .clinerules as directory → child .md
    await fs.mkdir(path.join(project, ".clinerules"), { recursive: true });
    const dirChild = await resolveMemoryDestPath(nodeFs, pathDeps(tmp), nodeJoiner, {
      tool: "cline",
      scope: "project",
      projectRoot: project,
      fileName: "team-defaults",
    });
    expect(dirChild.path).toBe(path.join(project, ".clinerules", "team-defaults.md"));
    expect(dirChild.fixedSlot).toBe(false);
  });
});

describe("translate/memory transferMemory", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("translate-xfer");
  });
  afterEach(async () => {
    await rmrf(tmp);
  });

  it("writes the translated body to the destination, creating parent dirs", async () => {
    const project = path.join(tmp, "proj");
    const r = await transferMemory(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "claude",
      sourceName: "CLAUDE.md",
      sourceBody: "# memory\n",
      dest: { tool: "codex", scope: "project", projectRoot: project },
      mode: "replace",
    });
    expect(r.skipped).toBe(false);
    expect(r.destPath).toBe(path.join(project, "AGENTS.md"));
    const written = await fs.readFile(r.destPath, "utf8");
    expect(written).toBe("# memory\n");
  });

  it("backs up the previous content to <dest>.skillsafe.bak before overwriting", async () => {
    const project = path.join(tmp, "proj");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "AGENTS.md"), "old content");

    const r = await transferMemory(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "claude",
      sourceName: "CLAUDE.md",
      sourceBody: "new content",
      dest: { tool: "codex", scope: "project", projectRoot: project },
      mode: "replace",
    });
    expect(r.backupPath).toBe(path.join(project, "AGENTS.md.skillsafe.bak"));
    expect(await fs.readFile(r.backupPath!, "utf8")).toBe("old content");
    expect(await fs.readFile(r.destPath, "utf8")).toBe("new content");
  });

  it("append mode concatenates with a horizontal rule, leaving the original above", async () => {
    const project = path.join(tmp, "proj");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "CLAUDE.md"), "first\n");

    const r = await transferMemory(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "codex",
      sourceName: "AGENTS.md",
      sourceBody: "second\n",
      dest: { tool: "claude", scope: "project", projectRoot: project },
      mode: "append",
    });
    const out = await fs.readFile(r.destPath, "utf8");
    expect(out.startsWith("first")).toBe(true);
    expect(out).toContain("---");
    expect(out).toContain("second");
  });

  it("skip-if-exists leaves the destination untouched and reports skipped=true", async () => {
    const project = path.join(tmp, "proj");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "AGENTS.md"), "keep me");

    const r = await transferMemory(nodeFs, pathDeps(tmp), nodeJoiner, {
      sourceTool: "claude",
      sourceName: "CLAUDE.md",
      sourceBody: "would clobber",
      dest: { tool: "codex", scope: "project", projectRoot: project },
      mode: "skip-if-exists",
    });
    expect(r.skipped).toBe(true);
    expect(await fs.readFile(r.destPath, "utf8")).toBe("keep me");
  });
});

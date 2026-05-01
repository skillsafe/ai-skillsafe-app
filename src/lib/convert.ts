import type { MarkdownArtifact } from "./artifacts/types";

export interface ConvertOptions {
  targetTool: "claude" | "codex" | "cursor" | "openclaw" | "cline" | "hermes";
  targetType: "skill" | "agent" | "command";
}

export interface Converted {
  fileName: string;
  isBundle: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
}

export function convertArtifact(source: MarkdownArtifact, opts: ConvertOptions): Converted {
  const { targetTool, targetType } = opts;
  const sourceFm = source.frontmatter;
  const name = (sourceFm.name as string | undefined) ?? source.name;
  const description = (sourceFm.description as string | undefined) ?? "";
  const body = source.body;

  if (targetTool === "cursor") {
    const fm: Record<string, unknown> = {};
    if (description) fm.description = description;
    const paths = sourceFm.paths ?? sourceFm.globs;
    if (paths) fm.globs = paths;
    if (sourceFm.alwaysApply !== undefined) fm.alwaysApply = sourceFm.alwaysApply;
    return { fileName: `${slug(name)}.mdc`, isBundle: false, frontmatter: fm, body };
  }

  if (targetTool === "cline") {
    // Cline uses `paths:` in frontmatter (cursor uses `globs:`); rewrite accordingly.
    const fm: Record<string, unknown> = {};
    if (description) fm.description = description;
    const paths = sourceFm.paths ?? sourceFm.globs;
    if (paths) fm.paths = paths;
    return { fileName: `${slug(name)}.md`, isBundle: false, frontmatter: fm, body };
  }

  if (targetTool === "codex") {
    if (targetType === "command") {
      return { fileName: `${slug(name)}.md`, isBundle: false, frontmatter: {}, body: prependTitle(name, body) };
    }
    return { fileName: "AGENTS.md", isBundle: false, frontmatter: {}, body: prependTitle(name, body) };
  }

  if (targetTool === "openclaw" || targetTool === "hermes") {
    // OpenClaw and Hermes both use the agentskills.io SKILL.md bundle shape,
    // identical to Claude's; pass frontmatter through.
    const fm = {
      name,
      description,
      ...passthroughClaudeFields(sourceFm),
    };
    return { fileName: "SKILL.md", isBundle: true, frontmatter: fm, body };
  }

  if (targetType === "skill") {
    const fm = {
      name,
      description,
      ...passthroughClaudeFields(sourceFm),
    };
    return { fileName: "SKILL.md", isBundle: true, frontmatter: fm, body };
  }
  return {
    fileName: `${slug(name)}.md`,
    isBundle: false,
    frontmatter: { name, description, ...passthroughClaudeFields(sourceFm) },
    body,
  };
}

function passthroughClaudeFields(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["allowed-tools", "model", "argument-hint", "paths", "tools"]) {
    if (fm[key] !== undefined) out[key] = fm[key];
  }
  return out;
}

function prependTitle(name: string, body: string): string {
  if (body.trimStart().startsWith("#")) return body;
  return `# ${name}\n\n${body}`;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "artifact";
}

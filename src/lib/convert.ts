import type { MarkdownArtifact, Tool } from "./artifacts/types";

export interface ConvertOptions {
  targetTool: Tool;
  targetType: "skill" | "agent" | "command";
}

export interface Converted {
  fileName: string;
  isBundle: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
}

// Conversion rules:
//   * targetType === "skill" — emit a SKILL.md bundle for every tool. This
//     matches vercel-labs/skills' format, which is the only skill format the
//     app discovers now that the cursor-rules / cline-rules listing was
//     dropped.
//   * targetType === "agent" + targetTool === "codex" — emit AGENTS.md.
//   * targetType === "command" + targetTool === "codex" — emit a flat
//     <slug>.md prompt under .codex/prompts/.
//   * Everything else (e.g. claude agent/command files) — emit a flat
//     <slug>.md with passthrough frontmatter.
export function convertArtifact(source: MarkdownArtifact, opts: ConvertOptions): Converted {
  const { targetTool, targetType } = opts;
  const sourceFm = source.frontmatter;
  const name = (sourceFm.name as string | undefined) ?? source.name;
  const description = (sourceFm.description as string | undefined) ?? "";
  const body = source.body;

  if (targetType === "skill") {
    const fm = {
      name,
      description,
      ...passthroughClaudeFields(sourceFm),
    };
    return { fileName: "SKILL.md", isBundle: true, frontmatter: fm, body };
  }

  if (targetTool === "codex") {
    if (targetType === "command") {
      return {
        fileName: `${slug(name)}.md`,
        isBundle: false,
        frontmatter: {},
        body: prependTitle(name, body),
      };
    }
    // agent
    return {
      fileName: "AGENTS.md",
      isBundle: false,
      frontmatter: {},
      body: prependTitle(name, body),
    };
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

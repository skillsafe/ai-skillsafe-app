import matter from "gray-matter";

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  raw: string;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const parsed = matter(raw);
  return {
    data: (parsed.data ?? {}) as Record<string, unknown>,
    body: parsed.content.replace(/^\n/, ""),
    raw,
  };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const hasData = data && Object.keys(data).length > 0;
  if (!hasData) return body.endsWith("\n") ? body : body + "\n";
  return matter.stringify(body, data);
}

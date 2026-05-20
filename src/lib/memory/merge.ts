import type { MemorySource } from "./walker";

// Render the effective memory view: sources concatenated in the order
// agents would actually consume them, with per-source markers so the user
// can see which file contributed which lines. Markers are HTML comments —
// invisible to most rendered Markdown viewers, but easy to grep for if
// the user pipes the merged view back into an LLM.

export interface MergedView {
  /** The full concatenated body. */
  text: string;
  /** Per-source byte offsets in the merged text. */
  offsets: Array<{ source: MemorySource; start: number; end: number }>;
}

export function mergeMemory(sources: ReadonlyArray<MemorySource>): MergedView {
  const ordered = [...sources].sort(compareForMerge);
  const parts: string[] = [];
  const offsets: MergedView["offsets"] = [];
  let cursor = 0;
  for (const src of ordered) {
    const header = `<!-- from: ${src.path} (${src.tool}, ${src.scope}, depth=${src.depth}) -->\n`;
    const body = src.content.endsWith("\n") ? src.content : src.content + "\n";
    const block = header + body + "\n";
    parts.push(block);
    offsets.push({ source: src, start: cursor, end: cursor + block.length });
    cursor += block.length;
  }
  return { text: parts.join(""), offsets };
}

/** Stable ordering: global first (closest to what an agent loads first),
 * then project (depth 0), then ancestors by increasing depth. */
function compareForMerge(a: MemorySource, b: MemorySource): number {
  const scopeOrder: Record<MemorySource["scope"], number> = {
    global: 0,
    project: 1,
    ancestor: 2,
  };
  if (scopeOrder[a.scope] !== scopeOrder[b.scope]) {
    return scopeOrder[a.scope] - scopeOrder[b.scope];
  }
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.path.localeCompare(b.path);
}

import type { FsAdapter } from "../fs";
import { safeExists } from "../fs";
import type { PathJoiner } from "../artifacts/skill";

// Walks upward from a starting directory collecting memory files (CLAUDE.md,
// AGENTS.md, .cursorrules, .clinerules). Stops at a depth limit, at any
// parent containing a *different* .git directory (so we don't accidentally
// drag in memory from a containing monorepo or the user's home repo), and
// at the filesystem root.
//
// Also reads the user's global config dir (~/.claude/CLAUDE.md, ~/.codex/
// AGENTS.md, etc.) so the merged view reflects what an agent actually sees
// — that's the practical reason for a "Memory Linter" pane: surface the
// concatenation surprise that bites teams using nested CLAUDE.md files.

export interface MemorySource {
  path: string;
  tool: MemoryTool;
  scope: "global" | "project" | "ancestor";
  content: string;
  /** Directory depth from the starting root (0 = root itself). */
  depth: number;
}

export type MemoryTool = "claude" | "codex" | "cursor" | "cline";

export interface WalkOptions {
  /** Project root to walk upward from. */
  startDir: string;
  /** Cap on how many parent directories to traverse. Default 5.
   * Boundary stop conditions still apply earlier. */
  maxDepth?: number;
  /** Home directory — used to find the global memory files (~/.claude/CLAUDE.md etc).
   * Pass null to skip global scope. */
  homeDir?: string | null;
}

// Each tool's project-scope filenames. Order matters for stable output; we
// emit sources in walker-stable order so the merged view is deterministic.
const PROJECT_FILES: Array<{ name: string; tool: MemoryTool }> = [
  { name: "CLAUDE.md", tool: "claude" },
  { name: "AGENTS.md", tool: "codex" },
  { name: ".cursorrules", tool: "cursor" },
  { name: ".clinerules", tool: "cline" },
];

const GLOBAL_FILES: Array<{ rel: string[]; tool: MemoryTool }> = [
  { rel: [".claude", "CLAUDE.md"], tool: "claude" },
  { rel: [".codex", "AGENTS.md"], tool: "codex" },
  // Cursor has no documented global memory file (rules live under
  // <project>/.cursor/rules/*.mdc), so global scope is Claude/Codex only.
];

export async function walkMemorySources(
  fs: FsAdapter,
  pj: PathJoiner,
  options: WalkOptions,
): Promise<MemorySource[]> {
  const out: MemorySource[] = [];

  // 1. Global scope first (the agent reads it before project scope).
  if (options.homeDir) {
    for (const g of GLOBAL_FILES) {
      const path = await joinAll(pj, [options.homeDir, ...g.rel]);
      const content = await tryRead(fs, path);
      if (content !== null) {
        out.push({ path, tool: g.tool, scope: "global", content, depth: -1 });
      }
    }
  }

  // 2. Walk upward from startDir. Stop on .git boundary, root, or depth cap.
  const maxDepth = options.maxDepth ?? 5;
  let cur = options.startDir;
  const startGit = await dirHasGit(fs, pj, cur);
  for (let depth = 0; depth <= maxDepth; depth++) {
    // Boundary check *before* reading. If the current dir is an ancestor
    // and has a different .git than the start, it's a different repo —
    // don't bridge into it. (The start dir itself is always read.)
    if (depth > 0) {
      const hasGit = await dirHasGit(fs, pj, cur);
      if (hasGit && hasGit !== startGit) break;
    }
    // Read each tool's memory file in this dir.
    for (const f of PROJECT_FILES) {
      const path = await pj.join(cur, f.name);
      const content = await tryRead(fs, path);
      if (content !== null) {
        out.push({
          path,
          tool: f.tool,
          scope: depth === 0 ? "project" : "ancestor",
          content,
          depth,
        });
      }
    }
    const parent = parentDir(cur);
    if (parent === null || parent === cur) break; // reached fs root
    cur = parent;
  }

  return out;
}

async function joinAll(pj: PathJoiner, parts: string[]): Promise<string> {
  let p = parts[0];
  for (let i = 1; i < parts.length; i++) p = await pj.join(p, parts[i]);
  return p;
}

async function tryRead(fs: FsAdapter, path: string): Promise<string | null> {
  if (!(await safeExists(fs, path))) return null;
  try {
    return await fs.readTextFile(path);
  } catch {
    return null;
  }
}

async function dirHasGit(fs: FsAdapter, pj: PathJoiner, dir: string): Promise<string | null> {
  const gitPath = await pj.join(dir, ".git");
  return (await safeExists(fs, gitPath)) ? gitPath : null;
}

function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx < 0) return null;
  if (idx === 0) return p.length > 1 ? "/" : null;
  return p.slice(0, idx);
}

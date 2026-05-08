import type { FsAdapter } from "../fs";
import { safeReadDir } from "../fs";
import type { PathResolverDeps } from "../paths";
import type { PathJoiner } from "../artifacts/skill";

// Suggested allow rule built from observed tool use in past transcripts.
// Counts let the UI rank by frequency so the user sees their most common
// commands first.
export interface SuggestedRule {
  rule: string; // e.g. "Bash(git status)" or "Bash(git *)"
  count: number; // how many times we saw it
  example?: string; // a representative full command for tooltips
}

interface TranscriptToolUse {
  name?: string;
  input?: Record<string, unknown>;
}

// Walks ~/.claude/projects/*/*.jsonl and tallies tool calls, then turns the
// commonest Bash invocations into "Bash(<cmd>)" rules. We deliberately keep
// this conservative — exact-match rules first, then a glob fallback for any
// command that recurs with varied arguments.
export async function scanTranscriptsForRules(
  fs: FsAdapter,
  pj: PathJoiner,
  paths: PathResolverDeps,
  options: {
    // Cap the number of files we walk per run so a user with thousands of
    // sessions doesn't pay a multi-second startup cost.
    maxFiles?: number;
    // Cap the bytes read from any single jsonl so a multi-MB session log
    // doesn't blow up the renderer.
    maxBytesPerFile?: number;
  } = {},
): Promise<SuggestedRule[]> {
  const home = await paths.homeDir();
  const projectsRoot = await pj.join(home, ".claude", "projects");
  const top = await safeReadDir(fs, projectsRoot);
  const jsonlPaths: string[] = [];
  for (const e of top) {
    if (!e.isDirectory) continue;
    const dir = await pj.join(projectsRoot, e.name);
    for (const f of await safeReadDir(fs, dir)) {
      if (!f.isFile || !f.name.endsWith(".jsonl")) continue;
      jsonlPaths.push(await pj.join(dir, f.name));
    }
  }
  jsonlPaths.sort();
  const maxFiles = options.maxFiles ?? 200;
  const sliced = jsonlPaths.slice(-maxFiles); // newest sort last; bias to recent

  const exactCounts = new Map<string, number>();
  const headCounts = new Map<string, number>();
  const headExample = new Map<string, string>();

  for (const path of sliced) {
    try {
      const text = await readBoundedTextFile(fs, path, options.maxBytesPerFile ?? 2 * 1024 * 1024);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const uses = extractToolUses(line);
        for (const use of uses) {
          if (use.name !== "Bash") continue;
          const cmd = pickBashCommand(use.input);
          if (!cmd) continue;
          exactCounts.set(cmd, (exactCounts.get(cmd) ?? 0) + 1);
          const head = headOf(cmd);
          if (head) {
            headCounts.set(head, (headCounts.get(head) ?? 0) + 1);
            if (!headExample.has(head)) headExample.set(head, cmd);
          }
        }
      }
    } catch {
      /* skip unreadable file */
    }
  }

  return rankRules(exactCounts, headCounts, headExample);
}

function extractToolUses(line: string): TranscriptToolUse[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const message = (parsed as { message?: unknown }).message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: TranscriptToolUse[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    if (type !== "tool_use") continue;
    const name = (block as { name?: unknown }).name;
    const input = (block as { input?: unknown }).input;
    out.push({
      name: typeof name === "string" ? name : undefined,
      input:
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

function pickBashCommand(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const cmd = input.command;
  if (typeof cmd !== "string") return null;
  return cmd.trim();
}

// Head = first command word, with the leading subcommand attached for git/npm-
// style tools so a "git" rule doesn't lump checkouts in with status. Returns
// null for empty / pipeline-only lines.
function headOf(cmd: string): string | null {
  // Strip leading env-var assignments like FOO=bar.
  const stripped = cmd.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/i, "");
  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const program = tokens[0];
  // For multi-verb tools, include the subcommand for a more useful rule.
  const TWO_WORD = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "kubectl", "docker", "gh", "brew"]);
  if (TWO_WORD.has(program) && tokens.length >= 2 && /^[a-z][a-z0-9-]*$/i.test(tokens[1])) {
    return `${program} ${tokens[1]}`;
  }
  return program;
}

function rankRules(
  exact: Map<string, number>,
  heads: Map<string, number>,
  headExample: Map<string, string>,
): SuggestedRule[] {
  const out: SuggestedRule[] = [];
  // Exact rules first when the user always types the same thing — count >= 3
  // and the command is short enough to read.
  for (const [cmd, n] of exact) {
    if (n >= 3 && cmd.length <= 60 && !cmd.includes("\n")) {
      out.push({ rule: `Bash(${cmd})`, count: n, example: cmd });
    }
  }
  // Glob fallback for heads the user used >=2 times.
  for (const [head, n] of heads) {
    if (n < 2) continue;
    const rule = `Bash(${head}:*)`;
    if (out.some((r) => r.rule === rule)) continue;
    out.push({ rule, count: n, example: headExample.get(head) });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, 50);
}

async function readBoundedTextFile(
  fs: FsAdapter,
  path: string,
  maxBytes: number,
): Promise<string> {
  // Tauri's plugin-fs doesn't expose a partial read, so we read the whole
  // file but cap by byte length post-hoc. Files past the cap get truncated
  // at the last newline so we don't try to parse a half-line.
  const text = await fs.readTextFile(path);
  if (text.length <= maxBytes) return text;
  const cut = text.slice(0, maxBytes);
  const lastNl = cut.lastIndexOf("\n");
  return lastNl > 0 ? cut.slice(0, lastNl) : cut;
}

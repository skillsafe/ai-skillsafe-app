// Memory translators — port a memory file's content from one tool's
// format to another. PR 3 covers claude (CLAUDE.md), codex (AGENTS.md),
// cursor (.cursor/rules/*.mdc), and cline (.clinerules — file or dir).
//
// Cursor's .mdc files are markdown with optional YAML-ish frontmatter
// fenced by `---`; everything else is plain markdown. The translator
// parses the source body into a tiny intermediate representation
// (frontmatter + body) and re-renders for the destination.
//
// Transfers are reversible-ish: we write a `<dest>.skillsafe.bak` next
// to the destination on overwrite so the user can recover by hand if
// they overwrite the wrong file. A formal Revert UI lives in a later PR.

import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeExists } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { PathResolverDeps } from "../paths";
import { getHome } from "../paths";
import type { WorkbenchScope } from "../inventory/types";

export interface MemoryIR {
  frontmatter: Record<string, unknown>;
  body: string;
}

const MDC_FENCE = "---";

// ---------- parse / render ----------

function parseMdc(raw: string): MemoryIR {
  if (!raw.startsWith(`${MDC_FENCE}\n`) && !raw.startsWith(`${MDC_FENCE}\r\n`)) {
    return { frontmatter: {}, body: raw };
  }
  const closingDelim = `\n${MDC_FENCE}\n`;
  const closingIdx = raw.indexOf(closingDelim, MDC_FENCE.length);
  if (closingIdx < 0) return { frontmatter: {}, body: raw };
  const fmText = raw.slice(MDC_FENCE.length + 1, closingIdx).trim();
  // Strip the customary blank line between frontmatter and body so the
  // IR holds just the body text. renderMdc re-adds the separator.
  const body = raw.slice(closingIdx + closingDelim.length).replace(/^\r?\n/, "");
  const fm: Record<string, unknown> = {};
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = parseScalar(m[2]);
  }
  return { frontmatter: fm, body };
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "null") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);
  }
  return v.replace(/^["']|["']$/g, "");
}

function formatScalar(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map((x) => `"${String(x)}"`).join(", ")}]`;
  }
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (v == null) return "";
  return String(v);
}

function renderMdc(ir: MemoryIR): string {
  const lines = [MDC_FENCE];
  for (const [k, v] of Object.entries(ir.frontmatter)) {
    lines.push(`${k}: ${formatScalar(v)}`);
  }
  lines.push(MDC_FENCE);
  // Ensure exactly one blank line between frontmatter and body for tidy
  // round-trip diffs.
  const trimmedBody = ir.body.replace(/^\s*\n/, "");
  return `${lines.join("\n")}\n\n${trimmedBody}`;
}

/** Tool-specific source parsers. Cursor MDC has frontmatter; others don't. */
export function parseMemoryFor(tool: string, raw: string): MemoryIR {
  if (tool === "cursor") return parseMdc(raw);
  return { frontmatter: {}, body: raw };
}

/** Tool-specific destination renderers. */
export function renderMemoryFor(
  tool: string,
  ir: MemoryIR,
  opts: { sourceName?: string } = {},
): string {
  if (tool === "cursor") {
    const fm = { ...ir.frontmatter };
    // Cursor's UI surfaces the description; populate from source name if
    // the source format had no frontmatter at all.
    if (!fm.description && opts.sourceName) {
      fm.description = stripExtension(opts.sourceName);
    }
    return renderMdc({ frontmatter: fm, body: ir.body });
  }
  return ir.body;
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

// ---------- destination path resolution ----------

export interface MemoryDestination {
  tool: string;
  scope: WorkbenchScope;
  /** Required when scope is "project". */
  projectRoot?: string;
  /**
   * Filename hint for tools that can hold multiple memory files (cursor's
   * `.cursor/rules/*.mdc` and cline's `.clinerules/` directory mode).
   * Ignored for tools with a single canonical file.
   */
  fileName?: string;
}

export interface ResolvedDest {
  path: string;
  warnings: string[];
  /**
   * Tools with a single fixed memory file (claude, codex). Transfer to
   * these always overwrites or appends — there's no per-name slot.
   */
  fixedSlot: boolean;
}

export async function resolveMemoryDestPath(
  fs: FsAdapter,
  paths: PathResolverDeps,
  pj: PathJoiner,
  dest: MemoryDestination,
): Promise<ResolvedDest> {
  const warnings: string[] = [];
  const home = await getHome(paths);

  if (dest.tool === "claude") {
    if (dest.scope === "global") {
      return {
        path: await pj.join(home, ".claude", "CLAUDE.md"),
        warnings,
        fixedSlot: true,
      };
    }
    if (!dest.projectRoot) throw new Error("Project root is required for project scope.");
    return {
      path: await pj.join(dest.projectRoot, "CLAUDE.md"),
      warnings,
      fixedSlot: true,
    };
  }

  if (dest.tool === "codex") {
    if (dest.scope === "global") {
      return {
        path: await pj.join(home, ".codex", "AGENTS.md"),
        warnings,
        fixedSlot: true,
      };
    }
    if (!dest.projectRoot) throw new Error("Project root is required for project scope.");
    return {
      path: await pj.join(dest.projectRoot, "AGENTS.md"),
      warnings,
      fixedSlot: true,
    };
  }

  if (dest.tool === "cursor") {
    if (dest.scope === "global") {
      warnings.push("Cursor doesn't have a global memory location; using project scope.");
    }
    if (!dest.projectRoot) {
      throw new Error("Cursor memory is project-scoped; pick a project root.");
    }
    const slug = sanitizeSlug(stripExtension(dest.fileName || "memory"));
    return {
      path: await pj.join(dest.projectRoot, ".cursor", "rules", `${slug}.mdc`),
      warnings,
      fixedSlot: false,
    };
  }

  if (dest.tool === "cline") {
    if (dest.scope === "global") {
      warnings.push("Cline only supports project-scope memory; using project scope.");
    }
    if (!dest.projectRoot) {
      throw new Error("Cline memory is project-scoped; pick a project root.");
    }
    const single = await pj.join(dest.projectRoot, ".clinerules");
    if (await safeExists(fs, single)) {
      try {
        const stat = await fs.stat(single);
        if (stat.isDirectory) {
          const slug = sanitizeSlug(stripExtension(dest.fileName || "memory"));
          return {
            path: await pj.join(single, `${slug}.md`),
            warnings,
            fixedSlot: false,
          };
        }
      } catch {
        /* fall through to single-file mode */
      }
    }
    return { path: single, warnings, fixedSlot: true };
  }

  throw new Error(`Memory transfer to ${dest.tool} is not supported yet.`);
}

function sanitizeSlug(s: string): string {
  return s.replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, "-") || "memory";
}

// ---------- transfer ----------

export type TransferMode = "replace" | "append" | "skip-if-exists";

export interface TransferMemoryInput {
  sourceTool: string;
  sourceName: string;
  sourceBody: string;
  dest: MemoryDestination;
  mode: TransferMode;
}

export interface TransferMemoryResult {
  destPath: string;
  warnings: string[];
  /** Path to the .skillsafe.bak we wrote before overwriting, if any. */
  backupPath?: string;
  /** Final on-disk content. Useful for the dialog's success preview. */
  written: string | null;
  /** True when we skipped the write (mode=skip-if-exists and dest existed). */
  skipped: boolean;
}

export async function transferMemory(
  fs: FsAdapter,
  paths: PathResolverDeps,
  pj: PathJoiner,
  input: TransferMemoryInput,
): Promise<TransferMemoryResult> {
  const ir = parseMemoryFor(input.sourceTool, input.sourceBody);
  const renderedSource = renderMemoryFor(input.dest.tool, ir, {
    sourceName: input.sourceName,
  });
  const { path: destPath, warnings } = await resolveMemoryDestPath(
    fs,
    paths,
    pj,
    input.dest,
  );

  let backupPath: string | undefined;
  let prevContent: string | null = null;
  if (await safeExists(fs, destPath)) {
    if (input.mode === "skip-if-exists") {
      warnings.push(`Destination already exists; left untouched: ${destPath}`);
      return {
        destPath,
        warnings,
        written: null,
        skipped: true,
      };
    }
    try {
      prevContent = await fs.readTextFile(destPath);
      backupPath = `${destPath}.skillsafe.bak`;
      await atomicWrite(fs, backupPath, prevContent);
    } catch {
      // Best-effort: if the read or backup write fails, log a warning and
      // continue with the user-chosen overwrite. The user explicitly
      // asked for this; we shouldn't refuse the action just because we
      // couldn't preserve a copy.
      warnings.push(
        `Couldn't write a .skillsafe.bak before overwriting ${destPath}.`,
      );
      backupPath = undefined;
    }
  }

  const dir = parentDir(destPath);
  if (dir) await ensureDir(fs, dir);

  let payload = renderedSource;
  if (input.mode === "append" && prevContent !== null) {
    const sep = prevContent.endsWith("\n") ? "" : "\n";
    payload = `${prevContent}${sep}\n---\n\n${renderedSource}`;
  }

  await atomicWrite(fs, destPath, payload);
  return {
    destPath,
    warnings,
    backupPath,
    written: payload,
    skipped: false,
  };
}

// ---------- helpers ----------

function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

/** Tools where memory transfer is supported in PR 3. */
export const MEMORY_TRANSFER_TARGETS = ["claude", "codex", "cursor", "cline"] as const;
export type MemoryTransferTool = typeof MEMORY_TRANSFER_TARGETS[number];

export function isMemoryTransferTool(tool: string): tool is MemoryTransferTool {
  return (MEMORY_TRANSFER_TARGETS as readonly string[]).includes(tool);
}

/** Tools that have a global memory location. Others force project scope. */
export const MEMORY_GLOBAL_CAPABLE: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * Render a translation preview without writing. Useful for the
 * TransferDialog's live preview pane.
 */
export function previewMemoryTransfer(input: {
  sourceTool: string;
  sourceName: string;
  sourceBody: string;
  destTool: string;
}): string {
  const ir = parseMemoryFor(input.sourceTool, input.sourceBody);
  return renderMemoryFor(input.destTool, ir, { sourceName: input.sourceName });
}

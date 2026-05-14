// TS-side conflict scanner. Walks each restore mapping's source (under the
// backup folder) and destination (the live tree), producing one ConflictItem
// per file that would change. The React UI uses this to show a checkbox list
// so the user can pick a subset to restore — distinct from the bash script's
// all-or-nothing dry-run.

import { safeExists, safeReadDir, type FsAdapter } from "../fs";
import type { RestoreMapping } from "./generateScripts";

export type ConflictKind = "new" | "modified" | "extra";

export interface ConflictItem {
  /** Stable id used as React key + selection key. */
  id: string;
  /** Section label (e.g. "Claude Code · Skills · skills/"). */
  section: string;
  /** Path relative to the section's root, for display. */
  rel: string;
  /** Absolute path inside the backup folder (empty for "extra"). */
  srcPath: string;
  /** Absolute path in the live tree. */
  dstPath: string;
  kind: ConflictKind;
  srcSize: number | null;
  dstSize: number | null;
  srcMtimeMs: number | null;
  dstMtimeMs: number | null;
}

export interface ScanOptions {
  fs: FsAdapter;
  joiner: { join: (...parts: string[]) => Promise<string> };
  mappings: RestoreMapping[];
  /** When true, files in dst missing from src are reported as "extra". */
  mirror: boolean;
}

const TIME_TOLERANCE_MS = 2000;

export async function scanForConflicts(opts: ScanOptions): Promise<ConflictItem[]> {
  const all: ConflictItem[] = [];
  for (const m of opts.mappings) {
    const items = await scanMapping(opts.fs, opts.joiner, m, opts.mirror);
    all.push(...items);
  }
  return all;
}

async function scanMapping(
  fs: FsAdapter,
  joiner: { join: (...parts: string[]) => Promise<string> },
  m: RestoreMapping,
  mirror: boolean,
): Promise<ConflictItem[]> {
  if (m.kind === "file") {
    return scanFile(fs, m);
  }
  return scanDir(fs, joiner, m, mirror);
}

async function scanFile(fs: FsAdapter, m: RestoreMapping): Promise<ConflictItem[]> {
  const srcExists = await safeExists(fs, m.src);
  if (!srcExists) return [];
  const basename = baseName(m.src);
  // m.dst always ends in "/" for file-mode mappings — strip and join basename.
  const dstFull = stripTrailingSep(m.dst) + "/" + basename;
  const srcStat = await tryStat(fs, m.src);
  const dstStat = await tryStat(fs, dstFull);
  if (!srcStat || !srcStat.isFile) return [];
  if (!dstStat || !dstStat.isFile) {
    return [
      {
        id: `${m.label}::${basename}`,
        section: m.label,
        rel: basename,
        srcPath: m.src,
        dstPath: dstFull,
        kind: "new",
        srcSize: srcStat.size,
        dstSize: null,
        srcMtimeMs: srcStat.mtimeMs,
        dstMtimeMs: null,
      },
    ];
  }
  if (await filesAreEquivalent(fs, srcStat, dstStat, m.src, dstFull)) return [];
  return [
    {
      id: `${m.label}::${basename}`,
      section: m.label,
      rel: basename,
      srcPath: m.src,
      dstPath: dstFull,
      kind: "modified",
      srcSize: srcStat.size,
      dstSize: dstStat.size,
      srcMtimeMs: srcStat.mtimeMs,
      dstMtimeMs: dstStat.mtimeMs,
    },
  ];
}

async function scanDir(
  fs: FsAdapter,
  joiner: { join: (...parts: string[]) => Promise<string> },
  m: RestoreMapping,
  mirror: boolean,
): Promise<ConflictItem[]> {
  // Both src and dst end in "/" for tree-mode mappings.
  const srcRoot = stripTrailingSep(m.src);
  const dstRoot = stripTrailingSep(m.dst);
  if (!(await safeExists(fs, srcRoot))) return [];
  const srcMap = new Map<string, { size: number; mtime: number }>();
  await walk(fs, joiner, srcRoot, "", srcMap);
  const dstMap = new Map<string, { size: number; mtime: number }>();
  if (await safeExists(fs, dstRoot)) {
    await walk(fs, joiner, dstRoot, "", dstMap);
  }
  const out: ConflictItem[] = [];
  for (const [rel, sStat] of srcMap) {
    const dStat = dstMap.get(rel);
    const srcPath = `${srcRoot}/${rel}`;
    const dstPath = `${dstRoot}/${rel}`;
    if (!dStat) {
      out.push({
        id: `${m.label}::${rel}`,
        section: m.label,
        rel,
        srcPath,
        dstPath,
        kind: "new",
        srcSize: sStat.size,
        dstSize: null,
        srcMtimeMs: sStat.mtime,
        dstMtimeMs: null,
      });
      continue;
    }
    if (await filesAreEquivalent(
      fs,
      { size: sStat.size, mtimeMs: sStat.mtime, isFile: true, isDirectory: false },
      { size: dStat.size, mtimeMs: dStat.mtime, isFile: true, isDirectory: false },
      srcPath,
      dstPath,
    )) {
      continue;
    }
    out.push({
      id: `${m.label}::${rel}`,
      section: m.label,
      rel,
      srcPath,
      dstPath,
      kind: "modified",
      srcSize: sStat.size,
      dstSize: dStat.size,
      srcMtimeMs: sStat.mtime,
      dstMtimeMs: dStat.mtime,
    });
  }
  if (mirror) {
    for (const [rel, dStat] of dstMap) {
      if (srcMap.has(rel)) continue;
      out.push({
        id: `${m.label}::${rel}`,
        section: m.label,
        rel,
        srcPath: "",
        dstPath: `${dstRoot}/${rel}`,
        kind: "extra",
        srcSize: null,
        dstSize: dStat.size,
        srcMtimeMs: null,
        dstMtimeMs: dStat.mtime,
      });
    }
  }
  return out;
}

async function walk(
  fs: FsAdapter,
  joiner: { join: (...parts: string[]) => Promise<string> },
  root: string,
  rel: string,
  out: Map<string, { size: number; mtime: number }>,
): Promise<void> {
  const dir = rel ? `${root}/${rel}` : root;
  const entries = await safeReadDir(fs, dir);
  for (const e of entries) {
    if (e.name === "." || e.name === "..") continue;
    if (e.name === ".DS_Store") continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const childAbs = `${dir}/${e.name}`;
    if (e.isDirectory) {
      await walk(fs, joiner, root, childRel, out);
      continue;
    }
    if (!e.isFile) continue;
    const stat = await tryStat(fs, childAbs);
    if (!stat || !stat.isFile) continue;
    out.set(childRel, { size: stat.size, mtime: stat.mtimeMs });
  }
}

async function tryStat(
  fs: FsAdapter,
  p: string,
): Promise<{ mtimeMs: number; isFile: boolean; isDirectory: boolean; size: number } | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

// Hard cap on the byte-compare fallback. Files under this threshold are
// reliably classified; above it, we accept a possible false-positive
// "modified" rather than hash a 100MB file-history snapshot on every scan.
const MAX_BYTE_COMPARE_BYTES = 16 * 1024 * 1024;

async function filesAreEquivalent(
  fs: FsAdapter,
  a: { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean },
  b: { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean },
  aPath: string,
  bPath: string,
): Promise<boolean> {
  if (a.size !== b.size) return false;
  // Same size + mtime within tolerance ⇒ trust the heuristic, skip the read.
  if (Math.abs(a.mtimeMs - b.mtimeMs) <= TIME_TOLERANCE_MS) return true;
  // Same size, drifted mtimes: byte-compare so files whose timestamps were
  // bumped by an editor save (or copied across machines) don't show up as
  // false-positive conflicts.
  if (a.size > MAX_BYTE_COMPARE_BYTES) return false;
  if (!fs.readFile) return false;
  try {
    const [ab, bb] = await Promise.all([fs.readFile(aPath), fs.readFile(bPath)]);
    return bytesEqual(ab, bb);
  } catch {
    return false;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

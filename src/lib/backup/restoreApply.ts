// Applies a user-selected subset of ConflictItems back to the live tree.
// Per-file copy (or delete) so the user can pick exactly which files to
// restore — no rsync invocation, since rsync's unit of work is a directory.

import { ensureDir, type FsAdapter } from "../fs";
import type { ConflictItem } from "./restoreScan";

export interface ApplyOptions {
  fs: FsAdapter;
  items: readonly ConflictItem[];
  /** Fired before each file so the UI can update progress. */
  onProgress?: (done: number, total: number, current: ConflictItem) => void;
}

export interface ApplyResult {
  copied: number;
  deleted: number;
  failed: { item: ConflictItem; error: string }[];
}

export async function applyRestore(opts: ApplyOptions): Promise<ApplyResult> {
  const result: ApplyResult = { copied: 0, deleted: 0, failed: [] };
  const total = opts.items.length;
  let done = 0;
  for (const item of opts.items) {
    opts.onProgress?.(done, total, item);
    try {
      if (item.kind === "extra") {
        await opts.fs.remove(item.dstPath);
        result.deleted++;
      } else {
        const parent = parentDir(item.dstPath);
        if (parent) await ensureDir(opts.fs, parent);
        await copyFile(opts.fs, item.srcPath, item.dstPath);
        result.copied++;
      }
    } catch (e) {
      result.failed.push({
        item,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    done++;
  }
  opts.onProgress?.(done, total, opts.items[opts.items.length - 1]);
  return result;
}

async function copyFile(fs: FsAdapter, src: string, dst: string): Promise<void> {
  if (!fs.readFile || !fs.writeFile) {
    // Fallback for adapters that only support text. Restore targets include
    // binary files (e.g. pre-built plugin assets) so we generally rely on the
    // byte API; throw a clear error rather than silently corrupting binaries.
    throw new Error("FsAdapter does not support binary read/write");
  }
  const bytes = await fs.readFile(src);
  await fs.writeFile(dst, bytes);
}

function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return "";
  return trimmed.slice(0, idx);
}

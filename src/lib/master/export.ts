// Bulk export / import + bulk restore for the Workbench master folder.
// Reuses fflate (already a dep) for zipping; bulk restore composes
// restoreSourceFromMaster across every recorded source entry.

import { unzipSync, zipSync } from "fflate";
import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeReadDir, safeExists } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import {
  loadManifest,
  restoreSourceFromMaster,
} from "./store";
import type { Manifest, MasterEntry, MasterSource } from "./types";
import { MANIFEST_FILE } from "./types";

interface FilesMap {
  [relPath: string]: Uint8Array;
}

/** Walk every file under masterRoot and pack into a flat in-memory map. */
async function collectMasterFiles(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  prefix = "",
): Promise<FilesMap> {
  const out: FilesMap = {};
  const dirAbs = prefix ? await pj.join(masterRoot, ...prefix.split("/")) : masterRoot;
  const entries = await safeReadDir(fs, dirAbs);
  for (const e of entries) {
    if (e.name.startsWith(".") && !prefix) continue;
    const childRel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      const nested = await collectMasterFiles(fs, pj, masterRoot, childRel);
      Object.assign(out, nested);
    } else if (e.isFile) {
      const abs = await pj.join(masterRoot, ...childRel.split("/"));
      if (fs.readFile) {
        out[childRel] = await fs.readFile(abs);
      } else {
        const text = await fs.readTextFile(abs);
        out[childRel] = new TextEncoder().encode(text);
      }
    }
  }
  return out;
}

/** Pack the master folder into a zip Uint8Array. Includes manifest.json. */
export async function packMasterZip(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
): Promise<Uint8Array> {
  const files = await collectMasterFiles(fs, pj, masterRoot);
  if (Object.keys(files).length === 0) {
    throw new Error("Master folder is empty.");
  }
  return zipSync(files);
}

/**
 * Unzip a master archive into the target master root, overwriting files
 * with the same relative path. Manifest gets merged: imported entries
 * are appended, duplicates by id are deduped (importing wins).
 */
export interface ImportResult {
  filesWritten: number;
  /** Files that already existed and got replaced. */
  filesReplaced: number;
  /** Manifest entries imported on top of any existing ones. */
  manifestEntriesImported: number;
  warnings: string[];
}

export async function importMasterZip(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  archive: Uint8Array,
): Promise<ImportResult> {
  const unpacked = unzipSync(archive);
  await ensureDir(fs, masterRoot);

  const warnings: string[] = [];
  let filesWritten = 0;
  let filesReplaced = 0;
  let importedManifest: Manifest | null = null;

  // Sort so manifest.json is processed last — we want to merge into the
  // existing local manifest rather than blindly overwrite.
  const entries = Object.entries(unpacked).sort(([a], [b]) => {
    if (a === MANIFEST_FILE) return 1;
    if (b === MANIFEST_FILE) return -1;
    return a.localeCompare(b);
  });

  for (const [rel, bytes] of entries) {
    if (rel.endsWith("/")) continue; // directory entry
    if (rel === MANIFEST_FILE) {
      try {
        const text = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
          importedManifest = parsed as Manifest;
        }
      } catch {
        warnings.push("Imported manifest.json is not valid JSON; skipping merge.");
      }
      continue;
    }
    const abs = await pj.join(masterRoot, ...rel.split("/"));
    const dir = parentDir(abs);
    if (dir) await ensureDir(fs, dir);
    const existed = await safeExists(fs, abs);
    if (fs.writeFile) {
      await fs.writeFile(abs, bytes);
    } else {
      const text = new TextDecoder().decode(bytes);
      await atomicWrite(fs, abs, text);
    }
    if (existed) filesReplaced += 1;
    else filesWritten += 1;
  }

  // Merge manifest. Imported entries overwrite local ones with the same
  // id; everything else is preserved.
  let imported = 0;
  if (importedManifest) {
    const local = await loadManifest(fs, pj, masterRoot);
    const byId = new Map<string, MasterEntry>();
    for (const e of local.entries) byId.set(e.id, e);
    for (const e of importedManifest.entries) {
      byId.set(e.id, e);
      imported += 1;
    }
    const merged: Manifest = {
      version: 1,
      masterRoot,
      generatedAt: Date.now(),
      entries: Array.from(byId.values()),
    };
    const manifestPath = await pj.join(masterRoot, MANIFEST_FILE);
    await atomicWrite(fs, manifestPath, JSON.stringify(merged, null, 2) + "\n");
  }

  return {
    filesWritten,
    filesReplaced,
    manifestEntriesImported: imported,
    warnings,
  };
}

function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

// ---------- bulk restore ----------

export interface BulkRestorePlanRow {
  entry: MasterEntry;
  /** First recorded source for this entry (the canonical restore target). */
  source: MasterSource | null;
  /** Filename used when restoring MCP servers (the entry name). */
  itemName: string;
}

export function planBulkRestore(manifest: Manifest): BulkRestorePlanRow[] {
  return manifest.entries.map((e) => ({
    entry: e,
    source: e.sources[0] ?? null,
    itemName: deriveItemName(e),
  }));
}

function deriveItemName(entry: MasterEntry): string {
  // The masterPath ends with the filename SettingsJson treats as the
  // item name; for MCP entries we strip the .json extension.
  const last = entry.masterPath.split("/").pop() ?? entry.masterPath;
  if (entry.category === "mcp" && last.endsWith(".json")) return last.slice(0, -5);
  return last;
}

export interface BulkRestoreResult {
  succeeded: BulkRestorePlanRow[];
  failed: Array<{ row: BulkRestorePlanRow; error: string }>;
  skipped: Array<{ row: BulkRestorePlanRow; reason: string }>;
}

export async function applyBulkRestore(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  rows: ReadonlyArray<BulkRestorePlanRow>,
): Promise<BulkRestoreResult> {
  const succeeded: BulkRestorePlanRow[] = [];
  const failed: Array<{ row: BulkRestorePlanRow; error: string }> = [];
  const skipped: Array<{ row: BulkRestorePlanRow; reason: string }> = [];

  for (const row of rows) {
    if (!row.source) {
      skipped.push({ row, reason: "no recorded source — use Workbench → Transfer to push." });
      continue;
    }
    try {
      await restoreSourceFromMaster(
        fs,
        pj,
        masterRoot,
        row.entry,
        row.source,
        row.itemName,
      );
      succeeded.push(row);
    } catch (e) {
      failed.push({
        row,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { succeeded, failed, skipped };
}

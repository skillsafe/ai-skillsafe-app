import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, sha256Hex } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import { appendEntry, emptyIndex, findEntry, isDuplicateOfLatest } from "./index";
import type { HistoryEntry, HistoryIndex, SnapshotSource } from "./types";
import { INDEX_VERSION } from "./types";
import { pathKey } from "./pathKey";

export interface HistoryDeps {
  fs: FsAdapter;
  joiner: PathJoiner;
  root: string; // base dir (e.g. appDataDir() + "/edit-history")
}

async function indexDir(deps: HistoryDeps): Promise<string> {
  return deps.joiner.join(deps.root, "index");
}

async function blobsDir(deps: HistoryDeps, key: string): Promise<string> {
  return deps.joiner.join(deps.root, "blobs", key);
}

async function indexPath(deps: HistoryDeps, key: string): Promise<string> {
  return deps.joiner.join(await indexDir(deps), `${key}.json`);
}

async function blobPath(deps: HistoryDeps, key: string, entryId: string): Promise<string> {
  return deps.joiner.join(await blobsDir(deps, key), `${entryId}.txt`);
}

export async function loadIndex(deps: HistoryDeps, absPath: string): Promise<HistoryIndex> {
  const key = await pathKey(absPath);
  const file = await indexPath(deps, key);
  if (!(await deps.fs.exists(file))) return emptyIndex(absPath);
  try {
    const raw = await deps.fs.readTextFile(file);
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === INDEX_VERSION &&
      Array.isArray(parsed.entries) &&
      typeof parsed.absPath === "string"
    ) {
      return parsed as HistoryIndex;
    }
  } catch {
    // Corrupt index — return empty so the user can resume editing without
    // losing the underlying file. Old entries become unreadable but not fatal.
  }
  return emptyIndex(absPath);
}

async function saveIndex(deps: HistoryDeps, idx: HistoryIndex): Promise<void> {
  const key = await pathKey(idx.absPath);
  await ensureDir(deps.fs, await indexDir(deps));
  const file = await indexPath(deps, key);
  await atomicWrite(deps.fs, file, JSON.stringify(idx, null, 2));
}

export async function readSnapshot(
  deps: HistoryDeps,
  absPath: string,
  entryId: string,
): Promise<string | null> {
  const key = await pathKey(absPath);
  const file = await blobPath(deps, key, entryId);
  if (!(await deps.fs.exists(file))) return null;
  return deps.fs.readTextFile(file);
}

async function writeBlob(
  deps: HistoryDeps,
  key: string,
  entryId: string,
  content: string,
): Promise<void> {
  await ensureDir(deps.fs, await blobsDir(deps, key));
  await atomicWrite(deps.fs, await blobPath(deps, key, entryId), content);
}

async function deleteBlob(deps: HistoryDeps, key: string, entryId: string): Promise<void> {
  const file = await blobPath(deps, key, entryId);
  try {
    if (await deps.fs.exists(file)) await deps.fs.remove(file);
  } catch {
    // Best-effort: a stale blob is harmless; the index is the source of truth.
  }
}

export interface RecordResult {
  index: HistoryIndex;
  entry: HistoryEntry | null; // null when content matched the latest snapshot (deduped)
  deduped: boolean;
}

export async function recordSnapshot(
  deps: HistoryDeps,
  absPath: string,
  content: string,
  source: SnapshotSource,
): Promise<RecordResult> {
  const key = await pathKey(absPath);
  const idx = await loadIndex(deps, absPath);
  const sha = await sha256Hex(content);
  if (isDuplicateOfLatest(idx, sha)) {
    return { index: idx, entry: null, deduped: true };
  }
  const { next, entry, dropped } = appendEntry(idx, {
    sha256: sha,
    size: new TextEncoder().encode(content).length,
    source,
  });
  await writeBlob(deps, key, entry.id, content);
  await saveIndex(deps, next);
  for (const d of dropped) await deleteBlob(deps, key, d.id);
  return { index: next, entry, deduped: false };
}

export async function snapshotIfNew(
  deps: HistoryDeps,
  absPath: string,
  content: string,
  source: SnapshotSource,
): Promise<RecordResult> {
  return recordSnapshot(deps, absPath, content, source);
}

export async function getEntry(
  deps: HistoryDeps,
  absPath: string,
  entryId: string,
): Promise<HistoryEntry | null> {
  const idx = await loadIndex(deps, absPath);
  return findEntry(idx, entryId);
}

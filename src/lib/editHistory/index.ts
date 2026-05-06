import { HISTORY_CAP, INDEX_VERSION } from "./types";
import type { HistoryEntry, HistoryIndex, SnapshotSource } from "./types";

export function emptyIndex(absPath: string): HistoryIndex {
  return { version: INDEX_VERSION, absPath, entries: [] };
}

export function latestEntry(idx: HistoryIndex): HistoryEntry | null {
  return idx.entries.length > 0 ? idx.entries[idx.entries.length - 1] : null;
}

export function findEntry(idx: HistoryIndex, id: string): HistoryEntry | null {
  return idx.entries.find((e) => e.id === id) ?? null;
}

export function makeEntryId(ts: number): string {
  // Time-prefixed so directory listings sort chronologically; random suffix
  // disambiguates when two saves land in the same millisecond.
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export function appendEntry(
  idx: HistoryIndex,
  meta: { sha256: string; size: number; source: SnapshotSource; ts?: number },
): { next: HistoryIndex; entry: HistoryEntry; dropped: HistoryEntry[] } {
  const ts = meta.ts ?? Date.now();
  const entry: HistoryEntry = {
    id: makeEntryId(ts),
    ts,
    size: meta.size,
    sha256: meta.sha256,
    source: meta.source,
  };
  const entries = [...idx.entries, entry];
  return pruneToCap({ ...idx, entries }, entry, HISTORY_CAP);
}

function pruneToCap(
  idx: HistoryIndex,
  appended: HistoryEntry,
  cap: number,
): { next: HistoryIndex; entry: HistoryEntry; dropped: HistoryEntry[] } {
  if (idx.entries.length <= cap) {
    return { next: idx, entry: appended, dropped: [] };
  }
  const overflow = idx.entries.length - cap;
  const dropped = idx.entries.slice(0, overflow);
  const kept = idx.entries.slice(overflow);
  return { next: { ...idx, entries: kept }, entry: appended, dropped };
}

export function removeEntry(
  idx: HistoryIndex,
  id: string,
): { next: HistoryIndex; removed: HistoryEntry | null } {
  const removed = findEntry(idx, id);
  if (!removed) return { next: idx, removed: null };
  return { next: { ...idx, entries: idx.entries.filter((e) => e.id !== id) }, removed };
}

export function isDuplicateOfLatest(idx: HistoryIndex, sha256: string): boolean {
  const last = latestEntry(idx);
  return last !== null && last.sha256 === sha256;
}

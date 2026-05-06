export type SnapshotSource = "pre-edit" | "save" | "pre-restore";

export interface HistoryEntry {
  id: string;
  ts: number;
  size: number;
  sha256: string;
  source: SnapshotSource;
}

export interface HistoryIndex {
  version: 1;
  absPath: string;
  entries: HistoryEntry[];
}

export const INDEX_VERSION = 1 as const;
export const HISTORY_CAP = 50;
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

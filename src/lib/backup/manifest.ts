import type { ArtifactType, Scope, Tool } from "../artifacts/types";

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = "LAST_BACKUP.json";
// Legacy wrapper subdir from a much earlier layout. Kept only so the
// BackupBrowser can fall back to reading an old top-level manifest. New
// backups live one level deeper, in per-tool <tool>_backup/ folders.
export const BACKUP_SUBDIR = "skillsafe-backup";

// Subdir name used for each tool inside the user's chosen backup destination.
// Per-tool subdirs let two backup runs (e.g. claude + codex) execute
// concurrently without racing on a single shared manifest file.
export function toolBackupSubdir(tool: Tool): string {
  return `${tool}_backup`;
}

export type BackupEntryKind = "artifact" | "project";
export type BackupEntryStatus = "added" | "changed" | "unchanged";

export interface BackupEntry {
  kind: BackupEntryKind;
  tool?: Tool;
  scope?: Exclude<Scope, "all">;
  type?: Exclude<ArtifactType, "all">;
  projectRoot?: string;
  relPath: string;
  // Absolute path to the file in the destination — kept so the UI can open it
  // in the system viewer without having to recompute joins later.
  destPath: string;
  sha256: string;
  bytes: number;
  status: BackupEntryStatus;
}

export interface BackupCounts {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
}

export interface BackupManifest {
  version: number;
  generatedAt: number;
  destination: string;
  counts: BackupCounts;
  entries: BackupEntry[];
  errors: string[];
}

export interface RecentChange {
  relPath: string;
  destPath: string;
  status: BackupEntryStatus;
  bytes: number;
}

export interface BackupStats {
  generatedAt: number;
  counts: BackupCounts;
  totalBytes: number;
  errorCount: number;
  // First few error messages, kept for the in-app status panel so the user
  // can see which paths failed without opening the manifest file.
  errorSamples: string[];
  // Up to 30 added/changed entries from the most recent run, so the user can
  // preview what just got mirrored without browsing the destination tree.
  recentChanges: RecentChange[];
  // Where the manifest lives in the destination (i.e. <dest>/skillsafe-backup).
  // Cached so the "Browse backup folder" button doesn't have to recompute it.
  backupRoot: string;
}

export function emptyCounts(): BackupCounts {
  return { added: 0, changed: 0, removed: 0, unchanged: 0 };
}

export function deriveBackupRoot(destination: string): string {
  // The destination is now the backup root directly (no skillsafe-backup
  // wrapper). Older manifests may have appended the wrapper — strip it for
  // backward-compat so the UI's "Browse backup folder" button still works.
  const trimmed = destination.replace(/[\\/]+$/, "");
  const tail = trimmed.split(/[\\/]/).pop();
  if (tail === BACKUP_SUBDIR) {
    return trimmed.slice(0, trimmed.length - BACKUP_SUBDIR.length - 1);
  }
  return trimmed;
}

export function summarize(manifest: BackupManifest): BackupStats {
  const totalBytes = manifest.entries.reduce((sum, e) => sum + e.bytes, 0);
  const recentChanges: RecentChange[] = manifest.entries
    .filter((e) => e.status !== "unchanged")
    .slice(0, 30)
    .map((e) => ({
      relPath: e.relPath,
      destPath: e.destPath,
      status: e.status,
      bytes: e.bytes,
    }));
  return {
    generatedAt: manifest.generatedAt,
    counts: { ...manifest.counts },
    errorSamples: manifest.errors.slice(0, 10),
    recentChanges,
    backupRoot: deriveBackupRoot(manifest.destination),
    totalBytes,
    errorCount: manifest.errors.length,
  };
}

export function serializeManifest(m: BackupManifest): string {
  return JSON.stringify(m, null, 2);
}

export function parseManifest(text: string): BackupManifest | null {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.version !== "number") return null;
    if (!Array.isArray(parsed.entries)) return null;
    const m = parsed as BackupManifest;
    // Older manifests (written before summary.ts filtered .DS_Store at
    // every depth) may contain Finder droppings as full entries. Strip
    // them on read so the BackupBrowser doesn't show them until the next
    // backup run rewrites the manifest.
    m.entries = m.entries.filter((e) => {
      const base = e.relPath?.split("/").pop() ?? "";
      return base !== ".DS_Store";
    });
    return m;
  } catch {
    return null;
  }
}

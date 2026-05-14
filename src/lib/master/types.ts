// Master store types — the canonical, user-versionable folder of files
// that aggregates each tool's memory / MCP / hooks / etc. into one place.
//
// Each MasterEntry tracks where it came from (sources) and where its
// canonical content lives on disk (masterPath, relative to the master
// root). The manifest stores metadata only; payload bytes live in their
// own files so the user can browse/diff/git the master folder by hand.

import type { StateCategory, WorkbenchScope } from "../inventory/types";

export interface MasterSource {
  tool: string;
  scope: WorkbenchScope;
  /** Absolute project path; null for global. */
  projectPath: string | null;
  /** Origin path on disk at the time of Add-to-Master / last sync. */
  absPath: string;
  /** Hash of the source payload at last sync. Drift = current ≠ this. */
  lastSyncedHash: string;
  lastSyncedAt: number;
}

export interface MasterEntry {
  /** Stable id matching the originating InventoryItem.id when sources length is 1. */
  id: string;
  category: StateCategory;
  /** Path relative to the master root (e.g. "memory/global/claude--CLAUDE.md"). */
  masterPath: string;
  /** SHA-256 hex of the canonical payload as written to disk. */
  canonicalHash: string;
  /**
   * Tool whose payload shape is canonically stored at `masterPath`. Used by
   * cross-tool memory restore to know which parser/renderer pair to apply.
   * Set on first write; preserved across bind/unbind so removing the
   * original contributor doesn't silently change the canonical shape.
   * Optional for back-compat with manifests written before this field
   * existed — readers fall back to `sources[0].tool` when absent.
   */
  canonicalTool?: string;
  sources: MasterSource[];
  updatedAt: number;
  /** User-editable note. Preserved across sync. */
  notes?: string;
}

export interface Manifest {
  version: 1;
  /** Absolute master root the manifest was written for; informational only. */
  masterRoot: string;
  generatedAt: number;
  entries: MasterEntry[];
}

export const MANIFEST_VERSION = 1;

export const MANIFEST_FILE = "manifest.json";

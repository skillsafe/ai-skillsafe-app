// Aggregates each <dest>/<tool>_backup/LAST_BACKUP.json into one
// in-memory BackupManifest. Replaces the old whole-destination walker
// in summary.ts: per-tool manifests already track adds/changes/removes
// and stay scoped to their tool's files, so a top-level <dest>/LAST_BACKUP.json
// is no longer written.

import { ALL_AGENTS } from "../agents/registry";
import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  parseManifest,
  toolBackupSubdir,
  type BackupEntry,
  type BackupManifest,
} from "./manifest";

export async function aggregateToolManifests(
  fs: FsAdapter,
  joiner: PathJoiner,
  destination: string,
): Promise<BackupManifest | null> {
  const counts = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  const entries: BackupEntry[] = [];
  const errors: string[] = [];
  let generatedAt = 0;
  let any = false;
  for (const tool of ALL_AGENTS) {
    const path = await joiner.join(
      destination,
      toolBackupSubdir(tool),
      MANIFEST_FILENAME,
    );
    if (!(await fs.exists(path))) continue;
    try {
      const text = await fs.readTextFile(path);
      const m = parseManifest(text);
      if (!m) continue;
      any = true;
      counts.added += m.counts.added;
      counts.changed += m.counts.changed;
      counts.removed += m.counts.removed;
      counts.unchanged += m.counts.unchanged;
      entries.push(...m.entries);
      errors.push(...m.errors);
      if (m.generatedAt > generatedAt) generatedAt = m.generatedAt;
    } catch {
      // Skip unreadable per-tool manifests; surface a generic error
      // upstream if the caller cares.
    }
  }
  if (!any) return null;
  return {
    version: MANIFEST_VERSION,
    generatedAt,
    destination,
    counts,
    entries,
    errors,
  };
}

// BulkRestoreDialog — pick which master entries to restore to their
// recorded sources in one shot. Useful on a fresh machine after copying
// the backup folder over: install the AI tools, point SkillSafe at the
// backup folder, then bulk-restore every master entry into place.

import { useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { displayNameOf } from "../lib/agents/registry";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import {
  applyBulkRestore,
  planBulkRestore,
  type BulkRestorePlanRow,
} from "../lib/master/export";
import { resolveMasterRoot } from "../lib/master/store";
import type { Manifest } from "../lib/master/types";

interface Props {
  manifest: Manifest;
  onClose: () => void;
  onSuccess: (text: string) => void;
  onError: (text: string) => void;
}

export function BulkRestoreDialog({ manifest, onClose, onSuccess, onError }: Props) {
  const masterRoot = useApp((s) => s.masterRoot);
  const backupDestination = useApp((s) => s.backupDestination);

  const rows = useMemo(() => planBulkRestore(manifest), [manifest]);
  const restorable = useMemo(() => rows.filter((r) => r.source !== null), [rows]);
  const orphans = useMemo(() => rows.filter((r) => r.source === null), [rows]);

  // All restorable rows selected by default.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(restorable.map((r) => r.entry.id)),
  );
  const [busy, setBusy] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === restorable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(restorable.map((r) => r.entry.id)));
    }
  }

  async function handleApply() {
    setBusy(true);
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      const targets = restorable.filter((r) => selected.has(r.entry.id));
      if (targets.length === 0) {
        onError("Nothing selected.");
        return;
      }
      const result = await applyBulkRestore(tauriFs, tauriJoiner, root, targets);
      const parts = [
        `Restored ${result.succeeded.length} of ${targets.length} master entr${
          targets.length === 1 ? "y" : "ies"
        }.`,
      ];
      if (result.failed.length > 0) {
        parts.push(`${result.failed.length} failed.`);
      }
      if (result.skipped.length > 0) {
        parts.push(`${result.skipped.length} skipped.`);
      }
      if (result.failed.length > 0 || result.skipped.length > 0) {
        onError(
          parts.join(" ") +
            "\n" +
            [...result.failed.map((f) => `${f.row.itemName}: ${f.error}`),
              ...result.skipped.map((s) => `${s.row.itemName}: ${s.reason}`)].join("\n"),
        );
      } else {
        onSuccess(parts.join(" "));
      }
      onClose();
    } catch (e) {
      onError(`Bulk restore failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const allChecked = selected.size === restorable.length && restorable.length > 0;
  const someChecked = selected.size > 0 && selected.size < restorable.length;

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={busy ? undefined : onClose}
    >
      <div className="dialog bulk-restore-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="transfer-header">
          <h3 style={{ margin: 0 }}>Bulk restore from master</h3>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>
        <div className="bulk-body">
          {restorable.length === 0 ? (
            <div className="muted bulk-empty">
              No master entries have a recorded source on this machine. Use Workbench →
              Transfer to push individual entries to a tool.
            </div>
          ) : (
            <>
              <div className="bulk-row bulk-row-head">
                <input
                  type="checkbox"
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked;
                  }}
                  checked={allChecked}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
                <div className="bulk-col-name">Item</div>
                <div className="bulk-col-cat">Category</div>
                <div className="bulk-col-target">Restore target</div>
              </div>
              <div className="bulk-list">
                {restorable.map((r) => (
                  <BulkRow
                    key={r.entry.id}
                    row={r}
                    checked={selected.has(r.entry.id)}
                    onToggle={() => toggle(r.entry.id)}
                  />
                ))}
              </div>
            </>
          )}
          {orphans.length > 0 && (
            <div className="bulk-orphans">
              <div className="transfer-label" style={{ marginTop: 8 }}>
                Skipped ({orphans.length})
              </div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                These master entries have no recorded source. Use Workbench → Transfer
                to push them to a tool.
              </div>
              <ul className="bulk-orphan-list">
                {orphans.map((r) => (
                  <li key={r.entry.id}>
                    <span>{r.itemName}</span>
                    <span className="muted"> · {r.entry.category}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="dialog-row">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={handleApply}
            disabled={busy || selected.size === 0}
          >
            {busy ? "Restoring…" : `Restore ${selected.size} item${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkRow({
  row,
  checked,
  onToggle,
}: {
  row: BulkRestorePlanRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const target = row.source?.absPath ?? "";
  return (
    <label className="bulk-row">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div className="bulk-col-name">
        <div className="bulk-name">{row.itemName}</div>
        <div className="muted bulk-tool">
          {row.source ? displayNameOf(row.source.tool) : "—"}
        </div>
      </div>
      <div className="bulk-col-cat">{row.entry.category}</div>
      <div className="bulk-col-target">
        <code title={target}>{shorten(target)}</code>
      </div>
    </label>
  );
}

function shorten(p: string): string {
  const home = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)/);
  if (home) return p.replace(home[0], "~");
  return p;
}

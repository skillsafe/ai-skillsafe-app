// BulkRestoreDialog — pick which master entries to restore to their
// recorded sources in one shot. Useful on a fresh machine after copying
// the backup folder over: install the AI tools, point SkillSafe at the
// backup folder, then bulk-restore every master entry into place.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
  const { t } = useTranslation();
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
        onError(t("bulkRestore.nothingSelected"));
        return;
      }
      const result = await applyBulkRestore(tauriFs, tauriJoiner, root, targets);
      const parts = [
        t("bulkRestore.restoredCount", { succeeded: result.succeeded.length, total: targets.length }),
      ];
      if (result.failed.length > 0) {
        parts.push(t("bulkRestore.failedCount", { count: result.failed.length }));
      }
      if (result.skipped.length > 0) {
        parts.push(t("bulkRestore.skippedCount", { count: result.skipped.length }));
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
      onError(t("bulkRestore.bulkRestoreFailed", { message: e instanceof Error ? e.message : String(e) }));
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
          <h3 style={{ margin: 0 }}>{t("bulkRestore.title")}</h3>
          <button className="icon-btn" aria-label={t("bulkRestore.closeAria")} onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>
        <div className="bulk-body">
          {restorable.length === 0 ? (
            <div className="muted bulk-empty">
              {t("bulkRestore.emptyState")}
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
                  aria-label={t("bulkRestore.selectAllAria")}
                />
                <div className="bulk-col-name">{t("bulkRestore.itemCol")}</div>
                <div className="bulk-col-cat">{t("bulkRestore.categoryCol")}</div>
                <div className="bulk-col-target">{t("bulkRestore.restoreTargetCol")}</div>
              </div>
              <div className="bulk-list">
                {restorable.map((r) => (
                  <BulkRow
                    key={r.entry.id}
                    row={r}
                    checked={selected.has(r.entry.id)}
                    onToggle={() => toggle(r.entry.id)}
                    t={t}
                  />
                ))}
              </div>
            </>
          )}
          {orphans.length > 0 && (
            <div className="bulk-orphans">
              <div className="transfer-label" style={{ marginTop: 8 }}>
                {t("bulkRestore.skippedSection", { count: orphans.length })}
              </div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                {t("bulkRestore.skippedHint")}
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
            {t("common.cancel")}
          </button>
          <button
            className="primary"
            onClick={handleApply}
            disabled={busy || selected.size === 0}
          >
            {busy ? t("bulkRestore.restoringButton") : t("bulkRestore.restoreButton", { count: selected.size })}
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
  t: TFunction;
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

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { atomicWrite } from "../lib/fs";
import { tauriFs } from "../lib/tauriAdapters";
import { getHistoryDeps } from "../lib/editHistory/runtime";
import { loadIndex, readSnapshot, recordSnapshot } from "../lib/editHistory/store";
import type { HistoryEntry, HistoryIndex } from "../lib/editHistory/types";
import { useApp } from "../lib/store";

interface Props {
  onReload?: () => void | Promise<void>;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function sourceLabel(s: HistoryEntry["source"], t: TFunction): string {
  switch (s) {
    case "pre-edit":
      return t("historyPanel.sourcePreEdit");
    case "save":
      return t("historyPanel.sourceSave");
    case "pre-restore":
      return t("historyPanel.sourcePreRestore");
  }
}

export function HistoryPanel({ onReload }: Props) {
  const { t } = useTranslation();
  const path = useApp((s) => s.historyPanelPath);
  const closePanel = useApp((s) => s.closeHistoryPanel);
  const openDiffEntry = useApp((s) => s.openDiffEntry);
  const viewedFile = useApp((s) => s.viewedFile);
  const setViewedFile = useApp((s) => s.setViewedFile);
  const [index, setIndex] = useState<HistoryIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const deps = await getHistoryDeps();
      const idx = await loadIndex(deps, path);
      setIndex(idx);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setIndex(null);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRestore = useCallback(
    async (entry: HistoryEntry) => {
      if (!path) return;
      if (busyId) return;
      const ok = window.confirm(t("historyPanel.restorePrompt", { time: formatTimestamp(entry.ts) }));
      if (!ok) return;
      setBusyId(entry.id);
      try {
        const deps = await getHistoryDeps();
        const currentDisk = await tauriFs.readTextFile(path);
        await recordSnapshot(deps, path, currentDisk, "pre-restore");
        const blob = await readSnapshot(deps, path, entry.id);
        if (blob === null) throw new Error(t("historyPanel.snapshotMissing"));
        await atomicWrite(tauriFs, path, blob);
        if (viewedFile && viewedFile.path === path) {
          setViewedFile({ ...viewedFile, content: blob });
        }
        await onReload?.();
        await refresh();
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setBusyId(null);
      }
    },
    [path, busyId, viewedFile, setViewedFile, onReload, refresh, t],
  );

  if (!path) return null;

  const entriesNewestFirst = index ? [...index.entries].reverse() : [];

  return (
    <aside className="history-panel">
      <header className="history-panel__header">
        <div>
          <div className="history-panel__title">{t("historyPanel.title")}</div>
          <div className="history-panel__path" title={path}>
            {path.split(/[\\/]/).pop()}
          </div>
        </div>
        <button className="history-panel__close" onClick={closePanel} aria-label={t("historyPanel.closeAria")}>
          ×
        </button>
      </header>
      {loading && <div className="history-panel__status">{t("common.loading")}</div>}
      {error && <div className="history-panel__status history-panel__status--error">{error}</div>}
      {!loading && !error && entriesNewestFirst.length === 0 && (
        <div className="history-panel__status">{t("historyPanel.empty")}</div>
      )}
      <ul className="history-panel__list">
        {entriesNewestFirst.map((entry) => (
          <li key={entry.id} className="history-entry">
            <button
              className="history-entry__main"
              onClick={() => openDiffEntry({ absPath: path, entryId: entry.id })}
              title={t("historyPanel.showDiffTitle")}
            >
              <div className="history-entry__row">
                <span className={`history-entry__source-badge history-entry__source-badge--${entry.source}`}>
                  {sourceLabel(entry.source, t)}
                </span>
                <span className="history-entry__time">{formatTimestamp(entry.ts)}</span>
              </div>
              <div className="history-entry__meta">{formatBytes(entry.size)}</div>
            </button>
            <button
              className="history-entry__restore"
              onClick={() => onRestore(entry)}
              disabled={busyId === entry.id}
            >
              {busyId === entry.id ? "…" : t("common.restore")}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

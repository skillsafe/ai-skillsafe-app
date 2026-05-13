// Workbench detail pane — right column when view === "workbench".
//
// Reads the selected inventory item from the store and renders its origin
// path, last-seen mtime, master state, and a category-appropriate body
// preview. Action buttons add/update/restore/remove the item against the
// master folder. PR 2 ships memory + mcp categories; later PRs will fill
// in hooks/permissions/keybindings.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useApp } from "../lib/store";
import { displayNameOf } from "../lib/agents/registry";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import {
  addToMaster,
  loadManifest,
  masterStateFor,
  readMasterPayload,
  removeFromMaster,
  resolveMasterRoot,
  restoreSourceFromMaster,
  unbindSource,
  type MasterState,
} from "../lib/master/store";
import type { MasterEntry, MasterSource } from "../lib/master/types";
import type { InventoryItem, StateCategory } from "../lib/inventory/types";
import { TransferDialog } from "./TransferDialog";

export function Workbench() {
  const { t } = useTranslation();
  const inventory = useApp((s) => s.workbenchInventory);
  const selectedId = useApp((s) => s.workbenchSelectedId);
  const masterManifest = useApp((s) => s.masterManifest);
  const masterRoot = useApp((s) => s.masterRoot);
  const backupDestination = useApp((s) => s.backupDestination);
  const setMasterManifest = useApp((s) => s.setMasterManifest);
  const bumpWorkbenchScan = useApp((s) => s.bumpWorkbenchScan);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [masterBody, setMasterBody] = useState<string | null>(null);
  const [masterOnlyBody, setMasterOnlyBody] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  // The selected item can come from two sources:
  //   1. The inventory snapshot (live source on disk).
  //   2. A synthesized master-only item from InventoryList — only kept on
  //      the manifest, not the inventory. Look it up from the manifest
  //      instead.
  const masterItems = useApp((s) => s.masterItems);

  const selected = useMemo<InventoryItem | null>(() => {
    if (!selectedId) return null;
    // 1. Live inventory item.
    const live = inventory?.items.find((it) => it.id === selectedId);
    if (live) return live;
    // 2. Item synthesized from a master folder file (covers orphans
    //    that aren't in the manifest at all).
    const fromMaster = masterItems.find((it) => it.id === selectedId);
    if (fromMaster) return fromMaster;
    // 3. Last resort: synthesize from a manifest entry. Used when the
    //    inventory + master walk are still in flight.
    if (!masterManifest) return null;
    const entry = masterManifest.entries.find((e) => e.id === selectedId);
    if (!entry) return null;
    const firstSource = entry.sources[0];
    return {
      id: entry.id,
      tool: firstSource?.tool ?? "__master__",
      category: entry.category,
      scope: firstSource?.scope ?? "global",
      projectPath: firstSource?.projectPath ?? null,
      name: lastSegment(entry.masterPath) || entry.masterPath,
      absPath: entry.masterPath,
      payload: { masterPath: entry.masterPath },
      contentHash: entry.canonicalHash,
      lastSeen: entry.updatedAt,
      masterOnly: true,
    };
  }, [inventory, masterItems, selectedId, masterManifest]);

  const masterState = useMemo<MasterState | null>(() => {
    if (!masterManifest || !selected) return null;
    if (selected.masterOnly) {
      // Synthesized item — find the entry directly. There may be no
      // matching live source, so we surface a virtual MasterState that
      // points at the entry without a source.
      const entry = masterManifest.entries.find((e) => e.id === selected.id);
      if (!entry) return null;
      const firstSource = entry.sources[0];
      if (!firstSource) {
        // No live source recorded: render as in-master with a synthetic
        // source so the actions still have something to point at.
        return {
          kind: "in-sync",
          entry,
          source: {
            tool: "__master__",
            scope: "global",
            projectPath: null,
            absPath: entry.masterPath,
            lastSyncedHash: entry.canonicalHash,
            lastSyncedAt: entry.updatedAt,
          },
        };
      }
      return { kind: "in-sync", entry, source: firstSource };
    }
    return masterStateFor(masterManifest, selected);
  }, [masterManifest, selected]);

  const isMasterOnly = !!selected?.masterOnly;

  // Auto-clear toast after 3s on success; sticky on error so the user can
  // copy the message.
  useEffect(() => {
    if (!toast || toast.kind === "error") return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Reset diff/master-body cache when the selection changes.
  useEffect(() => {
    setShowDiff(false);
    setMasterBody(null);
    setMasterOnlyBody(null);
  }, [selectedId]);

  // Lazy-load the master payload for master-only items so we can render
  // it in the body preview directly. Manifest-tracked items use the
  // entry's masterPath; orphan files (synthesized by listMasterItems)
  // carry their relative master path on the payload object.
  useEffect(() => {
    if (!isMasterOnly || !selected) return;
    let cancelled = false;
    const payload = selected.payload;
    const relFromPayload =
      payload && typeof payload === "object" && "masterPath" in payload
        ? String((payload as { masterPath: unknown }).masterPath ?? "")
        : "";
    const rel =
      masterState && masterState.kind !== "not-in-master"
        ? masterState.entry.masterPath
        : relFromPayload;
    if (!rel) {
      setMasterOnlyBody("");
      return;
    }
    (async () => {
      try {
        const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
        const body = await readMasterPayload(tauriFs, tauriJoiner, root, rel);
        if (!cancelled) setMasterOnlyBody(body ?? "");
      } catch {
        if (!cancelled) setMasterOnlyBody("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isMasterOnly, selected, masterState, masterRoot, backupDestination]);

  async function reloadManifestOnly() {
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      const next = await loadManifest(tauriFs, tauriJoiner, root);
      setMasterManifest(next);
    } catch {
      /* surfaced via toast in the action handler */
    }
  }

  async function handleAddOrUpdate() {
    if (!selected) return;
    setBusy(true);
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      await addToMaster(tauriFs, tauriJoiner, root, selected);
      await reloadManifestOnly();
      // Master folder content changed — bump the scan nonce so other
      // master-aware views (Local backup browser, master-only inventory)
      // reload without the user clicking Refresh.
      bumpWorkbenchScan();
      setToast({
        kind: "ok",
        text: masterState?.kind === "drifted" ? t("workbench.toastMasterUpdated") : t("workbench.toastAddedToMaster"),
      });
    } catch (e) {
      setToast({ kind: "error", text: t("workbench.toastAddFailed", { message: errorMessage(e) }) });
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!selected || !masterState || masterState.kind === "not-in-master") return;
    setBusy(true);
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      await removeFromMaster(tauriFs, tauriJoiner, root, masterState.entry.id);
      await reloadManifestOnly();
      bumpWorkbenchScan();
      setToast({ kind: "ok", text: t("workbench.toastRemovedFromMaster") });
    } catch (e) {
      setToast({ kind: "error", text: t("workbench.toastRemoveFailed", { message: errorMessage(e) }) });
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!selected || !masterState || masterState.kind === "not-in-master") return;
    setBusy(true);
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      await restoreSourceFromMaster(
        tauriFs,
        tauriJoiner,
        root,
        masterState.entry,
        masterState.source,
        selected.name,
      );
      // Source contents changed; full re-scan is the cleanest way to
      // refresh the inventory's hashes and clear the drift badge.
      bumpWorkbenchScan();
      setToast({ kind: "ok", text: t("workbench.toastSourceRestored") });
    } catch (e) {
      setToast({ kind: "error", text: t("workbench.toastRestoreFailed", { message: errorMessage(e) }) });
    } finally {
      setBusy(false);
    }
  }

  // Restore one specific bound source (called from SourcesList rows).
  // Mirrors handleRestore but routes through the row's source instead of
  // masterState.source so the user can pick which target to push to.
  async function handleRestoreSource(entry: MasterEntry, src: MasterSource) {
    setBusy(true);
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      const itemName = lastSegment(entry.masterPath) || entry.masterPath;
      await restoreSourceFromMaster(tauriFs, tauriJoiner, root, entry, src, itemName);
      // Bump syncedHash so the next masterStateFor call shows in-sync.
      await reloadManifestOnly();
      bumpWorkbenchScan();
      setToast({
        kind: "ok",
        text: t("workbench.toastRestoredSource", { tool: displayNameOf(src.tool), scope: src.scope }),
      });
    } catch (e) {
      setToast({ kind: "error", text: t("workbench.toastRestoreFailed", { message: errorMessage(e) }) });
    } finally {
      setBusy(false);
    }
  }

  async function handleUnbindSource(entry: MasterEntry, src: MasterSource) {
    setBusy(true);
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      await unbindSource(tauriFs, tauriJoiner, root, entry.id, {
        tool: src.tool,
        scope: src.scope,
        projectPath: src.projectPath,
      });
      await reloadManifestOnly();
      bumpWorkbenchScan();
      setToast({
        kind: "ok",
        text: t("workbench.toastUnboundSource", { tool: displayNameOf(src.tool), scope: src.scope }),
      });
    } catch (e) {
      setToast({ kind: "error", text: t("workbench.toastUnbindFailed", { message: errorMessage(e) }) });
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenMasterFile() {
    if (!masterState || masterState.kind === "not-in-master") return;
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      const abs = await tauriJoiner.join(
        root,
        ...masterState.entry.masterPath.split("/").filter(Boolean),
      );
      await shellOpen(abs);
    } catch (e) {
      setToast({ kind: "error", text: t("workbench.toastCantOpenMaster", { message: errorMessage(e) }) });
    }
  }

  async function handleOpenSource() {
    if (!selected) return;
    try {
      await shellOpen(selected.absPath);
    } catch (e) {
      setToast({ kind: "error", text: t("workbench.toastCantOpenSource", { message: errorMessage(e) }) });
    }
  }

  async function handleToggleDiff() {
    if (showDiff) {
      setShowDiff(false);
      return;
    }
    if (!masterState || masterState.kind === "not-in-master") return;
    if (masterBody === null) {
      try {
        const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
        const body = await readMasterPayload(
          tauriFs,
          tauriJoiner,
          root,
          masterState.entry.masterPath,
        );
        setMasterBody(body);
      } catch (e) {
        setToast({ kind: "error", text: t("workbench.toastCantReadMaster", { message: errorMessage(e) }) });
        return;
      }
    }
    setShowDiff(true);
  }

  if (!selected) {
    return (
      <section className="editor-pane workbench-pane">
        <EmptyState t={t} />
      </section>
    );
  }

  const categoryLabel = t(`category.${selected.category}`, { defaultValue: selected.category });
  const subtitle = isMasterOnly
    ? t("workbench.subtitleMasterOnly", { category: categoryLabel })
    : t("workbench.subtitleLive", {
        tool: selected.tool === "__master__" ? t("workbench.subtitleMasterTool") : displayNameOf(selected.tool),
        category: categoryLabel,
        scope: selected.scope,
      });

  return (
    <section className="editor-pane workbench-pane">
      <div className="workbench-header">
        <div className="workbench-title">{selected.name}</div>
        <div className="workbench-subtitle">{subtitle}</div>
        <div className="workbench-path" title={selected.absPath}>
          {isMasterOnly && masterState && masterState.kind !== "not-in-master"
            ? `master/${masterState.entry.masterPath}`
            : selected.absPath}
        </div>
        <div className="workbench-meta">
          {selected.lastSeen
            ? t("workbench.lastModified", { time: formatTime(selected.lastSeen) })
            : t("workbench.noModTime")}
          <span className="workbench-meta-sep">·</span>
          <code className="workbench-hash">{selected.contentHash.slice(0, 12)}</code>
        </div>
        <StateCallout state={masterState} masterOnly={isMasterOnly} t={t} />
        <MasterActions
          state={masterState}
          masterOnly={isMasterOnly}
          category={selected.category}
          busy={busy}
          showDiff={showDiff}
          onAddOrUpdate={handleAddOrUpdate}
          onRestore={handleRestore}
          onRemove={handleRemove}
          onToggleDiff={handleToggleDiff}
          onOpenMasterFile={handleOpenMasterFile}
          onOpenSource={handleOpenSource}
          onTransfer={() => setTransferOpen(true)}
          t={t}
        />
      </div>
      {toast && (
        <div className={`workbench-toast workbench-toast-${toast.kind}`}>
          <span>{toast.text}</span>
          {toast.kind === "error" && (
            <button className="workbench-toast-close" onClick={() => setToast(null)}>
              ×
            </button>
          )}
        </div>
      )}
      <div className="workbench-body">
        {isMasterOnly ? (
          <MasterOnlyPreview category={selected.category} body={masterOnlyBody} t={t} />
        ) : showDiff && masterState && masterState.kind !== "not-in-master" ? (
          <DiffPreview item={selected} masterEntry={masterState.entry} masterBody={masterBody} t={t} />
        ) : (
          <PayloadPreview item={selected} t={t} />
        )}
        {masterState && masterState.kind !== "not-in-master" && (
          <SourcesList
            entry={masterState.entry}
            busy={busy}
            onRestoreSource={(s) => handleRestoreSource(masterState.entry, s)}
            onUnbindSource={(s) => handleUnbindSource(masterState.entry, s)}
            t={t}
          />
        )}
      </div>
      {transferOpen && (
        <TransferDialog
          source={selected}
          onClose={() => setTransferOpen(false)}
          onSuccess={(text) => setToast({ kind: "ok", text })}
          onError={(text) => setToast({ kind: "error", text })}
        />
      )}
    </section>
  );
}

/**
 * Single-sentence callout above the action buttons. Names the current
 * state in plain English so the user doesn't have to read seven button
 * labels and infer what's going on.
 */
function StateCallout({
  state,
  masterOnly,
  t,
}: {
  state: MasterState | null;
  masterOnly: boolean;
  t: TFunction;
}) {
  if (masterOnly) {
    return (
      <div className="state-callout state-callout-master-only">
        <span className="state-callout-icon">○</span>
        <div>
          <strong>{t("workbench.calloutMasterOnlyTitle")}</strong> {t("workbench.calloutMasterOnlyBody")}
        </div>
      </div>
    );
  }
  if (!state) {
    return null;
  }
  if (state.kind === "not-in-master") {
    return (
      <div className="state-callout state-callout-absent">
        <span className="state-callout-icon">·</span>
        <div>{t("workbench.calloutAbsent")}</div>
      </div>
    );
  }
  if (state.kind === "in-sync") {
    return (
      <div className="state-callout state-callout-sync">
        <span className="state-callout-icon">✓</span>
        <div>
          <strong>{t("workbench.calloutInSyncTitle")}</strong> {t("workbench.calloutInSyncBody")}
        </div>
      </div>
    );
  }
  return (
    <div className="state-callout state-callout-drift">
      <span className="state-callout-icon">⚠</span>
      <div>
        <strong>{t("workbench.calloutDriftTitle")}</strong> {t("workbench.calloutDriftBody")}
      </div>
    </div>
  );
}

function MasterActions({
  state,
  masterOnly,
  category,
  busy,
  showDiff,
  onAddOrUpdate,
  onRestore,
  onRemove,
  onToggleDiff,
  onOpenMasterFile,
  onOpenSource,
  onTransfer,
  t,
}: {
  state: MasterState | null;
  masterOnly: boolean;
  category: StateCategory;
  busy: boolean;
  showDiff: boolean;
  onAddOrUpdate: () => void;
  onRestore: () => void;
  onRemove: () => void;
  onToggleDiff: () => void;
  onOpenMasterFile: () => void;
  onOpenSource: () => void;
  onTransfer: () => void;
  t: TFunction;
}) {
  const isInMaster = state && state.kind !== "not-in-master";
  const drifted = state?.kind === "drifted";
  const transferSupported = category === "memory" || category === "mcp";

  // ----- master-only items ------------------------------------------------
  // No live source on this machine. The big move is "push this to a tool";
  // everything else is inspection or cleanup.
  if (masterOnly) {
    return (
      <div className="workbench-actions-stack">
        <div className="workbench-action-row workbench-action-primary">
          {transferSupported ? (
            <button
              className="primary"
              onClick={onTransfer}
              disabled={busy}
              title={t("workbench.transferToToolTitle")}
            >
              {t("workbench.transferToTool")}
            </button>
          ) : (
            <div className="muted">
              {t("workbench.noTransferTranslator", { category })}
            </div>
          )}
        </div>
        <ActionGroup label={t("workbench.inspectLabel")}>
          <button onClick={onOpenMasterFile} disabled={busy}>
            {t("workbench.openInMaster")}
          </button>
        </ActionGroup>
        <ActionGroup label={t("workbench.manageLabel")} muted>
          <button onClick={onRemove} disabled={busy} className="danger">
            {t("workbench.removeFromMaster")}
          </button>
        </ActionGroup>
      </div>
    );
  }

  // ----- live items -------------------------------------------------------
  const primaryLabel = drifted
    ? t("workbench.primaryUpdate")
    : isInMaster
      ? t("workbench.primaryReAdd")
      : t("workbench.primaryAdd");

  return (
    <div className="workbench-actions-stack">
      <div className="workbench-action-row workbench-action-primary">
        <button
          className="primary"
          onClick={onAddOrUpdate}
          disabled={busy}
          title={
            drifted
              ? t("workbench.primaryTitleDrifted")
              : isInMaster
                ? t("workbench.primaryTitleInMaster")
                : t("workbench.primaryTitleAdd")
          }
        >
          {primaryLabel}
        </button>
        {drifted && (
          <button
            className="primary primary-secondary"
            onClick={onRestore}
            disabled={busy}
            title={t("workbench.restoreFromMasterTitle")}
          >
            {t("workbench.restoreFromMaster")}
          </button>
        )}
      </div>

      <ActionGroup label={t("workbench.inspectLabel")}>
        {isInMaster && (
          <button onClick={onToggleDiff} disabled={busy}>
            {showDiff ? t("workbench.hideDiff") : t("workbench.diffVsMaster")}
          </button>
        )}
        <button onClick={onOpenSource} disabled={busy} title={t("workbench.openSourceTitle")}>
          {t("workbench.openSource")}
        </button>
        {isInMaster && (
          <button onClick={onOpenMasterFile} disabled={busy} title={t("workbench.openMasterFileTitle")}>
            {t("workbench.openMasterFile")}
          </button>
        )}
      </ActionGroup>

      {(isInMaster || transferSupported) && (
        <ActionGroup label={t("workbench.otherLabel")} muted>
          {transferSupported && (
            <button
              onClick={onTransfer}
              disabled={busy}
              title={t("workbench.transferAnotherTitle")}
            >
              {t("workbench.transferAnother")}
            </button>
          )}
          {isInMaster && !drifted && (
            <button
              onClick={onRestore}
              disabled={busy}
              title={t("workbench.restoreFromMasterAltTitle")}
            >
              {t("workbench.restoreFromMaster")}
            </button>
          )}
          {isInMaster && (
            <button onClick={onRemove} disabled={busy} className="danger">
              {t("workbench.removeFromMaster")}
            </button>
          )}
        </ActionGroup>
      )}
    </div>
  );
}

function ActionGroup({
  label,
  muted = false,
  children,
}: {
  label: string;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`workbench-action-row ${muted ? "workbench-action-muted" : ""}`}>
      <span className="workbench-action-label">{label}</span>
      <div className="workbench-action-buttons">{children}</div>
    </div>
  );
}

function MasterOnlyPreview({
  category,
  body,
  t,
}: {
  category: StateCategory;
  body: string | null;
  t: TFunction;
}) {
  if (body === null) {
    return <div className="workbench-loading-placeholder">{t("workbench.loadingMasterPayload")}</div>;
  }
  if (body === "") {
    return <div className="workbench-empty">{t("workbench.emptyMasterPayload")}</div>;
  }
  if (category === "memory") {
    return <pre className="workbench-payload workbench-payload-text">{body}</pre>;
  }
  // mcp + others: try to pretty-print JSON, fall back to raw text.
  try {
    const parsed = JSON.parse(body);
    return (
      <pre className="workbench-payload workbench-payload-json">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } catch {
    return <pre className="workbench-payload workbench-payload-text">{body}</pre>;
  }
}

function SourcesList({
  entry,
  busy,
  onRestoreSource,
  onUnbindSource,
  t,
}: {
  entry: MasterEntry;
  busy: boolean;
  onRestoreSource: (s: MasterSource) => void;
  onUnbindSource: (s: MasterSource) => void;
  t: TFunction;
}) {
  if (entry.sources.length === 0) {
    return (
      <div className="workbench-sources">
        <div className="workbench-sources-label">{t("workbench.boundSources")}</div>
        <div className="workbench-empty">
          {t("workbench.noBoundSources")}
        </div>
      </div>
    );
  }
  return (
    <div className="workbench-sources">
      <div className="workbench-sources-label">
        {t("workbench.boundSources")} <span className="muted">({entry.sources.length})</span>
      </div>
      <ul className="workbench-sources-list">
        {entry.sources.map((s, idx) => {
          const isMasterSentinel = s.tool === "__master__";
          // "" + 0 lastSyncedAt = bound but not yet synced (drift expected).
          const neverSynced = s.lastSyncedAt === 0 && s.lastSyncedHash === "";
          return (
            <li key={`${s.tool}-${s.scope}-${s.projectPath ?? ""}-${idx}`} className="workbench-source-item">
              <div className="workbench-source-row">
                <div className="workbench-source-meta">
                  <div className="workbench-source-tool">
                    {isMasterSentinel ? t("workbench.masterSentinel") : displayNameOf(s.tool)} · {s.scope}
                    {neverSynced && (
                      <span className="badge master-drift" title={t("workbench.boundTitle")}>
                        {t("workbench.boundBadge")}
                      </span>
                    )}
                  </div>
                  <div className="workbench-source-path" title={s.absPath}>
                    {s.absPath}
                  </div>
                </div>
                {!isMasterSentinel && (
                  <div className="workbench-source-actions">
                    <button
                      type="button"
                      onClick={() => onRestoreSource(s)}
                      disabled={busy}
                      title={t("workbench.restoreSourceTitle")}
                      data-testid={`restore-source-${s.tool}-${s.scope}`}
                    >
                      {t("workbench.restoreSource")}
                    </button>
                    <button
                      type="button"
                      onClick={() => onUnbindSource(s)}
                      disabled={busy}
                      title={t("workbench.unbindSourceTitle")}
                      data-testid={`unbind-source-${s.tool}-${s.scope}`}
                    >
                      {t("workbench.unbindSource")}
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function lastSegment(p: string): string {
  const segs = p.replace(/\/+$/, "").split(/[\\/]/);
  return segs[segs.length - 1] || p;
}

function EmptyState({ t }: { t: TFunction }) {
  return (
    <div className="workbench-empty-state">
      <div className="workbench-empty-title">{t("workbench.emptyStateTitle")}</div>
      <p>{t("workbench.emptyStateBody")}</p>
      <p className="workbench-empty-hint">{t("workbench.emptyStateHint")}</p>
    </div>
  );
}

function PayloadPreview({ item, t }: { item: InventoryItem; t: TFunction }) {
  if (item.category === "memory") {
    const body = isObjectWithKey(item.payload, "body") ? String(item.payload.body) : "";
    return (
      <pre className="workbench-payload workbench-payload-text">
        {body || t("workbench.emptyFile")}
      </pre>
    );
  }
  return (
    <pre className="workbench-payload workbench-payload-json">
      {safeJson(item.payload)}
    </pre>
  );
}

function DiffPreview({
  item,
  masterEntry,
  masterBody,
  t,
}: {
  item: InventoryItem;
  masterEntry: MasterEntry;
  masterBody: string | null;
  t: TFunction;
}) {
  const sourceText = renderForDiff(item);
  const masterText = masterBody ?? t("workbench.diffLoadingMaster");
  return (
    <div className="workbench-diff">
      <div className="workbench-diff-col">
        <div className="workbench-diff-label">{t("workbench.diffSourceLabel")}</div>
        <pre className="workbench-payload workbench-payload-text">{sourceText}</pre>
      </div>
      <div className="workbench-diff-col">
        <div className="workbench-diff-label">{t("workbench.diffMasterLabel", { path: masterEntry.masterPath })}</div>
        <pre className="workbench-payload workbench-payload-text">{masterText}</pre>
      </div>
    </div>
  );
}

function renderForDiff(item: InventoryItem): string {
  if (item.category === "memory") {
    return isObjectWithKey(item.payload, "body") ? String(item.payload.body) : "";
  }
  return safeJson(item.payload);
}

function isObjectWithKey<K extends string>(
  v: unknown,
  key: K,
): v is Record<K, unknown> {
  return typeof v === "object" && v !== null && key in (v as Record<string, unknown>);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function formatTime(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString();
  } catch {
    return String(epochMs);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const CATEGORY_LABEL: Record<StateCategory, string> = {
  skills: "Skills",
  agents: "Agents",
  commands: "Commands",
  memory: "Memory",
  mcp: "MCP servers",
  hooks: "Hooks",
  permissions: "Permissions",
  keybindings: "Keybindings",
  transcripts: "Transcripts",
};

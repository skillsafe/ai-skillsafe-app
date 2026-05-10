// Workbench detail pane — right column when view === "workbench".
//
// Reads the selected inventory item from the store and renders its origin
// path, last-seen mtime, master state, and a category-appropriate body
// preview. Action buttons add/update/restore/remove the item against the
// master folder. PR 2 ships memory + mcp categories; later PRs will fill
// in hooks/permissions/keybindings.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
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
        text: masterState?.kind === "drifted" ? "Master updated." : "Added to master.",
      });
    } catch (e) {
      setToast({ kind: "error", text: `Add to master failed: ${errorMessage(e)}` });
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
      setToast({ kind: "ok", text: "Removed from master." });
    } catch (e) {
      setToast({ kind: "error", text: `Remove failed: ${errorMessage(e)}` });
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
      setToast({ kind: "ok", text: "Source restored from master." });
    } catch (e) {
      setToast({ kind: "error", text: `Restore failed: ${errorMessage(e)}` });
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
        text: `Restored ${displayNameOf(src.tool)} (${src.scope}).`,
      });
    } catch (e) {
      setToast({ kind: "error", text: `Restore failed: ${errorMessage(e)}` });
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
        text: `Unbound ${displayNameOf(src.tool)} (${src.scope}). Destination file untouched.`,
      });
    } catch (e) {
      setToast({ kind: "error", text: `Unbind failed: ${errorMessage(e)}` });
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
      setToast({ kind: "error", text: `Couldn't open master file: ${errorMessage(e)}` });
    }
  }

  async function handleOpenSource() {
    if (!selected) return;
    try {
      await shellOpen(selected.absPath);
    } catch (e) {
      setToast({ kind: "error", text: `Couldn't open source file: ${errorMessage(e)}` });
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
        setToast({ kind: "error", text: `Couldn't read master payload: ${errorMessage(e)}` });
        return;
      }
    }
    setShowDiff(true);
  }

  if (!selected) {
    return (
      <section className="editor-pane workbench-pane">
        <EmptyState />
      </section>
    );
  }

  const subtitle = isMasterOnly
    ? `Master · ${selected.category}`
    : `${selected.tool === "__master__" ? "Master" : displayNameOf(selected.tool)} · ${selected.category} · ${selected.scope}`;

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
            ? `Last modified ${formatTime(selected.lastSeen)}`
            : "Modification time unavailable"}
          <span className="workbench-meta-sep">·</span>
          <code className="workbench-hash">{selected.contentHash.slice(0, 12)}</code>
        </div>
        <StateCallout state={masterState} masterOnly={isMasterOnly} />
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
          <MasterOnlyPreview category={selected.category} body={masterOnlyBody} />
        ) : showDiff && masterState && masterState.kind !== "not-in-master" ? (
          <DiffPreview item={selected} masterEntry={masterState.entry} masterBody={masterBody} />
        ) : (
          <PayloadPreview item={selected} />
        )}
        {masterState && masterState.kind !== "not-in-master" && (
          <SourcesList
            entry={masterState.entry}
            busy={busy}
            onRestoreSource={(s) => handleRestoreSource(masterState.entry, s)}
            onUnbindSource={(s) => handleUnbindSource(masterState.entry, s)}
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
}: {
  state: MasterState | null;
  masterOnly: boolean;
}) {
  if (masterOnly) {
    return (
      <div className="state-callout state-callout-master-only">
        <span className="state-callout-icon">○</span>
        <div>
          <strong>Master only.</strong> No live source on this machine.
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
        <div>Not in master yet. Add it to keep a curated copy.</div>
      </div>
    );
  }
  if (state.kind === "in-sync") {
    return (
      <div className="state-callout state-callout-sync">
        <span className="state-callout-icon">✓</span>
        <div>
          <strong>In master.</strong> Source matches the curated copy.
        </div>
      </div>
    );
  }
  return (
    <div className="state-callout state-callout-drift">
      <span className="state-callout-icon">⚠</span>
      <div>
        <strong>Drifted.</strong> Source has changed since it was added to master.
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
              title="Translate and write this to a tool's config location"
            >
              Transfer to a tool…
            </button>
          ) : (
            <div className="muted">
              No transfer translator yet for {category}. Open the file in master
              and copy by hand if needed.
            </div>
          )}
        </div>
        <ActionGroup label="Inspect">
          <button onClick={onOpenMasterFile} disabled={busy}>
            Open in master
          </button>
        </ActionGroup>
        <ActionGroup label="Manage" muted>
          <button onClick={onRemove} disabled={busy} className="danger">
            Remove from master
          </button>
        </ActionGroup>
      </div>
    );
  }

  // ----- live items -------------------------------------------------------
  // Primary action depends on state:
  //   not-in-master  → Add to master
  //   in-sync        → Re-add (uncommon; mostly a manual refresh)
  //   drifted        → Update master AND Restore source (real choice)
  const primaryLabel = drifted
    ? "Update master with source"
    : isInMaster
      ? "Re-add to master"
      : "Add to master";

  return (
    <div className="workbench-actions-stack">
      <div className="workbench-action-row workbench-action-primary">
        <button
          className="primary"
          onClick={onAddOrUpdate}
          disabled={busy}
          title={
            drifted
              ? "Capture the current source content into master"
              : isInMaster
                ? "Re-write the master copy from the current source"
                : "Save a curated copy of the source into the master folder"
          }
        >
          {primaryLabel}
        </button>
        {drifted && (
          <button
            className="primary primary-secondary"
            onClick={onRestore}
            disabled={busy}
            title="Overwrite the source with the curated master content"
          >
            Restore source from master
          </button>
        )}
      </div>

      <ActionGroup label="Inspect">
        {isInMaster && (
          <button onClick={onToggleDiff} disabled={busy}>
            {showDiff ? "Hide diff" : "Diff vs master"}
          </button>
        )}
        <button onClick={onOpenSource} disabled={busy} title="Open the source file in your default editor">
          Open source
        </button>
        {isInMaster && (
          <button onClick={onOpenMasterFile} disabled={busy} title="Open the master payload file">
            Open in master
          </button>
        )}
      </ActionGroup>

      {(isInMaster || transferSupported) && (
        <ActionGroup label="Other" muted>
          {transferSupported && (
            <button
              onClick={onTransfer}
              disabled={busy}
              title="Translate and write to another tool"
            >
              Transfer to another tool…
            </button>
          )}
          {isInMaster && !drifted && (
            <button
              onClick={onRestore}
              disabled={busy}
              title="Overwrite source with master content"
            >
              Restore source from master
            </button>
          )}
          {isInMaster && (
            <button onClick={onRemove} disabled={busy} className="danger">
              Remove from master
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
}: {
  category: StateCategory;
  body: string | null;
}) {
  if (body === null) {
    return <div className="workbench-loading-placeholder">Loading master payload…</div>;
  }
  if (body === "") {
    return <div className="workbench-empty">(master payload is empty or unreadable)</div>;
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
}: {
  entry: MasterEntry;
  busy: boolean;
  onRestoreSource: (s: MasterSource) => void;
  onUnbindSource: (s: MasterSource) => void;
}) {
  if (entry.sources.length === 0) {
    return (
      <div className="workbench-sources">
        <div className="workbench-sources-label">Bound sources</div>
        <div className="workbench-empty">
          No sources bound. Use <em>Transfer</em> to push the canonical body into a tool's
          location and bind it as a source.
        </div>
      </div>
    );
  }
  return (
    <div className="workbench-sources">
      <div className="workbench-sources-label">
        Bound sources <span className="muted">({entry.sources.length})</span>
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
                    {isMasterSentinel ? "Master" : displayNameOf(s.tool)} · {s.scope}
                    {neverSynced && (
                      <span className="badge master-drift" title="Bound but never synced — Restore to push the canonical body.">
                        bound
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
                      title="Write the master payload into this source's path."
                      data-testid={`restore-source-${s.tool}-${s.scope}`}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => onUnbindSource(s)}
                      disabled={busy}
                      title="Remove this source from the master entry. The destination file is not touched."
                      data-testid={`unbind-source-${s.tool}-${s.scope}`}
                    >
                      Unbind
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

function EmptyState() {
  return (
    <div className="workbench-empty-state">
      <div className="workbench-empty-title">Workbench</div>
      <p>
        Cross-tool inventory of memory files, MCP servers, hooks, permissions, and
        keybindings. Pick an item from the list to inspect what's on disk and add it
        to your master folder.
      </p>
      <p className="workbench-empty-hint">
        The master folder is just a folder of files — set its location in
        Settings → Workbench master folder. It's safe to <code>git init</code> the
        master folder and version-control your setup.
      </p>
    </div>
  );
}

function PayloadPreview({ item }: { item: InventoryItem }) {
  if (item.category === "memory") {
    const body = isObjectWithKey(item.payload, "body") ? String(item.payload.body) : "";
    return (
      <pre className="workbench-payload workbench-payload-text">
        {body || "(empty file)"}
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
}: {
  item: InventoryItem;
  masterEntry: MasterEntry;
  masterBody: string | null;
}) {
  const sourceText = renderForDiff(item);
  const masterText =
    masterBody ?? "(loading master payload…)";
  return (
    <div className="workbench-diff">
      <div className="workbench-diff-col">
        <div className="workbench-diff-label">Source on disk</div>
        <pre className="workbench-payload workbench-payload-text">{sourceText}</pre>
      </div>
      <div className="workbench-diff-col">
        <div className="workbench-diff-label">Master ({masterEntry.masterPath})</div>
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

// Workbench detail pane — right column when view === "workbench".
//
// Reads the selected inventory item from the store and renders its origin
// path, last-seen mtime, master state, and a category-appropriate body
// preview. Action buttons add/update/restore/remove the item against the
// master folder. PR 2 ships memory + mcp categories; later PRs will fill
// in hooks/permissions/keybindings.

import { useEffect, useMemo, useState } from "react";
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
} from "../lib/master/store";
import type { MasterEntry, MasterState } from "../lib/master/types";
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
          <span className="workbench-meta-sep">·</span>
          <MasterBadge state={masterState} masterOnly={isMasterOnly} />
        </div>
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
        {isMasterOnly && masterState && masterState.kind !== "not-in-master" && (
          <SourcesList entry={masterState.entry} />
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

function MasterBadge({
  state,
  masterOnly,
}: {
  state: MasterState | null;
  masterOnly: boolean;
}) {
  if (masterOnly) return <span className="badge master-in-sync">master only</span>;
  if (!state) return <span className="badge muted">checking…</span>;
  if (state.kind === "not-in-master") {
    return <span className="badge muted">not in master</span>;
  }
  if (state.kind === "in-sync") {
    return <span className="badge master-in-sync">in master</span>;
  }
  return <span className="badge master-drift">drift vs master</span>;
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
  // Memory + MCP have translators. Hooks / permissions / keybindings
  // translators ship in later PRs.
  const transferSupported = category === "memory" || category === "mcp";

  if (masterOnly) {
    return (
      <div className="workbench-actions">
        <button onClick={onOpenMasterFile} disabled={busy} title="Open the master payload file">
          Open in master
        </button>
        {transferSupported && (
          <button onClick={onTransfer} disabled={busy} title="Translate and copy to another tool">
            Transfer to…
          </button>
        )}
        <button onClick={onRemove} disabled={busy} className="danger">
          Remove from master
        </button>
      </div>
    );
  }

  return (
    <div className="workbench-actions">
      <button onClick={onAddOrUpdate} disabled={busy}>
        {drifted ? "Update master" : isInMaster ? "Re-add to master" : "Add to master"}
      </button>
      {transferSupported && (
        <button onClick={onTransfer} disabled={busy} title="Translate and copy to another tool">
          Transfer to…
        </button>
      )}
      <button onClick={onOpenSource} disabled={busy} title="Open the source file in your default editor">
        Open source
      </button>
      {isInMaster && (
        <>
          <button onClick={onToggleDiff} disabled={busy}>
            {showDiff ? "Hide diff" : "Diff vs master"}
          </button>
          <button onClick={onOpenMasterFile} disabled={busy} title="Open the master payload file">
            Open in master
          </button>
          <button onClick={onRestore} disabled={busy} title="Overwrite source with master content">
            Restore from master
          </button>
          <button onClick={onRemove} disabled={busy} className="danger">
            Remove from master
          </button>
        </>
      )}
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

function SourcesList({ entry }: { entry: MasterEntry }) {
  if (entry.sources.length === 0) {
    return (
      <div className="workbench-sources">
        <div className="workbench-sources-label">Sources</div>
        <div className="workbench-empty">No sources recorded.</div>
      </div>
    );
  }
  return (
    <div className="workbench-sources">
      <div className="workbench-sources-label">Sources</div>
      <ul className="workbench-sources-list">
        {entry.sources.map((s, idx) => (
          <li key={`${s.tool}-${idx}`} className="workbench-source-item">
            <div className="workbench-source-tool">
              {s.tool === "__master__" ? "Master" : displayNameOf(s.tool)} · {s.scope}
            </div>
            <div className="workbench-source-path" title={s.absPath}>
              {s.absPath}
            </div>
          </li>
        ))}
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

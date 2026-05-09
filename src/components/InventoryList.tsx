// Workbench inventory list — middle pane.
//
// Shows the read-only cross-tool inventory grouped by category. The user
// picks an item and the Workbench (right pane) renders its details.
// Filters by tool / category come from store fields the Sidebar drives.
//
// PR 1 has no actions on items — Add to Master and Transfer ship in PR 2+.

import { useEffect, useMemo, useRef, useState } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { save as saveDialog, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useApp } from "../lib/store";
import { displayNameOf } from "../lib/agents/registry";
import { isInstalled } from "../lib/agents/detect";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { ensureDir } from "../lib/fs";
import { scanInventory, groupByCategory } from "../lib/inventory/scanner";
import { toolsWithSurfaces } from "../lib/agents/state";
import {
  listMasterItems,
  loadManifest,
  masterStateFor,
  resolveMasterRoot,
} from "../lib/master/store";
import { importMasterZip, packMasterZip } from "../lib/master/export";
import type { Manifest } from "../lib/master/types";
import type { InventoryItem, StateCategory } from "../lib/inventory/types";
import { BulkRestoreDialog } from "./BulkRestoreDialog";
import { MergeMcpDialog } from "./MergeMcpDialog";

export const MASTER_TOOL_SENTINEL = "__master__";

const CATEGORY_LABELS: Record<StateCategory, string> = {
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

const CATEGORY_ORDER: StateCategory[] = [
  "memory",
  "mcp",
  "hooks",
  "permissions",
  "keybindings",
  "transcripts",
  "skills",
  "agents",
  "commands",
];

export function InventoryList() {
  const recentProjects = useApp((s) => s.recentProjects);
  const projectFilter = useApp((s) => s.projectFilter);
  const workbenchTool = useApp((s) => s.workbenchTool);
  const workbenchCategory = useApp((s) => s.workbenchCategory);
  const workbenchSelectedId = useApp((s) => s.workbenchSelectedId);
  const inventory = useApp((s) => s.workbenchInventory);
  const loading = useApp((s) => s.workbenchLoading);
  const error = useApp((s) => s.workbenchError);
  const masterRoot = useApp((s) => s.masterRoot);
  const masterManifest = useApp((s) => s.masterManifest);
  const masterItems = useApp((s) => s.masterItems);
  const backupDestination = useApp((s) => s.backupDestination);
  const scanNonce = useApp((s) => s.workbenchScanNonce);
  const setSelected = useApp((s) => s.setWorkbenchSelectedId);
  const setInventory = useApp((s) => s.setWorkbenchInventory);
  const setLoading = useApp((s) => s.setWorkbenchLoading);
  const setError = useApp((s) => s.setWorkbenchError);
  const setInstalled = useApp((s) => s.setWorkbenchInstalled);
  const setMasterManifest = useApp((s) => s.setMasterManifest);
  const setMasterRootResolved = useApp((s) => s.setMasterRootResolved);
  const setMasterItems = useApp((s) => s.setMasterItems);

  // Active scan generation, so a user-driven re-scan (or project change)
  // discards in-flight results from a previous run.
  const genRef = useRef(0);
  const [hasScanned, setHasScanned] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [headerToast, setHeaderToast] = useState<string | null>(null);

  function flashToast(text: string) {
    setHeaderToast(text);
    setTimeout(() => setHeaderToast(null), 4000);
  }

  const projectRoots = useMemo(() => {
    if (projectFilter && recentProjects.includes(projectFilter)) return [projectFilter];
    return recentProjects;
  }, [recentProjects, projectFilter]);

  useEffect(() => {
    let cancelled = false;
    const myGen = ++genRef.current;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Scan installed-state in parallel with the inventory walk so the
        // Sidebar tool selector can grey-out tools that aren't present.
        const tools = toolsWithSurfaces();
        const installedEntries = await Promise.all(
          tools.map(async (t) => [t, await isInstalled(tauriFs, tauriPaths, t)] as const),
        );
        const resolvedRoot = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
        const [snap, manifest] = await Promise.all([
          scanInventory({
            fs: tauriFs,
            paths: tauriPaths,
            tools,
            scopes: ["global", "project"],
            projectRoots,
          }),
          loadManifest(tauriFs, tauriJoiner, resolvedRoot),
        ]);
        if (cancelled || myGen !== genRef.current) return;
        // listMasterItems walks the resolved root and merges with the
        // manifest. Done after the manifest load so we can join entries.
        const masterFolderItems = await listMasterItems(
          tauriFs,
          tauriJoiner,
          resolvedRoot,
          manifest,
        );
        if (cancelled || myGen !== genRef.current) return;
        const installedMap: Record<string, boolean> = {};
        for (const [t, ok] of installedEntries) installedMap[t] = ok;
        setInstalled(installedMap);
        setInventory(snap);
        setMasterManifest(manifest);
        setMasterItems(masterFolderItems);
        setMasterRootResolved(resolvedRoot);
        setHasScanned(true);
      } catch (e) {
        if (cancelled || myGen !== genRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled && myGen === genRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    projectRoots,
    masterRoot,
    backupDestination,
    scanNonce,
    setInventory,
    setLoading,
    setError,
    setInstalled,
    setMasterManifest,
    setMasterItems,
    setMasterRootResolved,
  ]);

  const filtered = useMemo(() => {
    const items = inventory?.items ?? [];
    if (workbenchTool === MASTER_TOOL_SENTINEL) {
      // Master-source filter: enumerate every file actually present in
      // the master folder (via listMasterItems, joined with the
      // manifest). Orphan files — files on disk but missing from the
      // manifest — appear too so the user can preview anything they've
      // dropped in the folder by hand.
      return masterItems.filter((it) => {
        if (workbenchCategory && it.category !== workbenchCategory) return false;
        return true;
      });
    }
    return items.filter((it) => {
      if (workbenchTool && it.tool !== workbenchTool) return false;
      if (workbenchCategory && it.category !== workbenchCategory) return false;
      return true;
    });
  }, [inventory, workbenchTool, workbenchCategory, masterItems]);

  const grouped = useMemo(() => groupByCategory(filtered), [filtered]);

  async function openMasterFolder() {
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      await ensureDir(tauriFs, root);
      await shellOpen(root);
    } catch (e) {
      console.error("[workbench] open master folder:", e);
    }
  }

  async function exportMasterZip() {
    if (busyExport) return;
    setBusyExport(true);
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      const bytes = await packMasterZip(tauriFs, tauriJoiner, root);
      const fallbackName = `skillsafe-master-${new Date().toISOString().slice(0, 10)}.zip`;
      const target = await saveDialog({
        defaultPath: fallbackName,
        filters: [{ name: "Zip", extensions: ["zip"] }],
      });
      if (typeof target !== "string") return; // user cancelled
      if (!tauriFs.writeFile) {
        flashToast("Binary write isn't available in this environment.");
        return;
      }
      await tauriFs.writeFile(target, bytes);
      flashToast(`Exported master → ${target}`);
    } catch (e) {
      flashToast(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyExport(false);
    }
  }

  async function importMasterZipUI() {
    if (busyImport) return;
    setBusyImport(true);
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "Zip", extensions: ["zip"] }],
      });
      if (typeof picked !== "string") return; // cancelled
      if (!tauriFs.readFile) {
        flashToast("Binary read isn't available in this environment.");
        return;
      }
      const bytes = await tauriFs.readFile(picked);
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      const result = await importMasterZip(tauriFs, tauriJoiner, root, bytes);
      const parts = [
        `Imported ${result.filesWritten + result.filesReplaced} file${
          result.filesWritten + result.filesReplaced === 1 ? "" : "s"
        }`,
      ];
      if (result.filesReplaced > 0) parts.push(`(${result.filesReplaced} replaced)`);
      if (result.manifestEntriesImported > 0) {
        parts.push(`· ${result.manifestEntriesImported} manifest entries merged`);
      }
      flashToast(parts.join(" "));
      // Trigger a re-scan so the imported entries show up.
      bumpScan();
    } catch (e) {
      flashToast(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyImport(false);
    }
  }

  const bumpScan = useApp((s) => s.bumpWorkbenchScan);

  const sourceLabel =
    workbenchTool === MASTER_TOOL_SENTINEL
      ? "Master"
      : workbenchTool
        ? displayNameOf(workbenchTool)
        : "";

  return (
    <section className="list-pane workbench-list">
      <div className="workbench-list-header">
        <div className="section-label">
          Inventory
          {loading ? <span className="workbench-loading"> · scanning…</span> : null}
        </div>
        {inventory && (
          <div className="workbench-list-meta">
            {filtered.length} item{filtered.length === 1 ? "" : "s"}
            {sourceLabel ? ` · ${sourceLabel}` : ""}
            {workbenchCategory ? ` · ${CATEGORY_LABELS[workbenchCategory as StateCategory] ?? workbenchCategory}` : ""}
          </div>
        )}
        <div className="workbench-list-actions">
          <button
            type="button"
            className="link-btn"
            onClick={openMasterFolder}
            title="Open the Workbench master folder in Finder"
          >
            Open folder
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => setBulkOpen(true)}
            disabled={!masterManifest || masterManifest.entries.length === 0}
            title="Restore every master entry to its original on-disk source"
          >
            Bulk restore…
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => setMergeOpen(true)}
            title="Side-by-side compare two tools' MCP server lists"
          >
            Merge MCP…
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={exportMasterZip}
            disabled={busyExport}
            title="Pack the master folder into a single .zip"
          >
            {busyExport ? "Exporting…" : "Export zip"}
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={importMasterZipUI}
            disabled={busyImport}
            title="Unzip a master archive into this master folder"
          >
            {busyImport ? "Importing…" : "Import zip"}
          </button>
        </div>
        {headerToast && <div className="workbench-list-toast">{headerToast}</div>}
      </div>
      {bulkOpen && masterManifest && (
        <BulkRestoreDialog
          manifest={masterManifest}
          onClose={() => setBulkOpen(false)}
          onSuccess={(text) => {
            flashToast(text);
            bumpScan();
          }}
          onError={flashToast}
        />
      )}
      {mergeOpen && (
        <MergeMcpDialog
          items={inventory?.items ?? []}
          onClose={() => setMergeOpen(false)}
          onSuccess={flashToast}
          onError={flashToast}
        />
      )}

      {error && <div className="workbench-error">Scan failed: {error}</div>}

      {!loading && hasScanned && filtered.length === 0 && (
        <div className="workbench-empty">
          {workbenchTool || workbenchCategory
            ? "No items match this filter."
            : "Nothing on disk yet for the supported tools (Claude Code, Codex, Cursor, Cline). Try installing one and re-scanning."}
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const items = grouped.get(cat);
        if (!items || items.length === 0) return null;
        return (
          <div key={cat} className="workbench-group">
            <div className="workbench-group-label">{CATEGORY_LABELS[cat]}</div>
            {items.map((it) => (
              <ItemRow
                key={it.id}
                item={it}
                active={it.id === workbenchSelectedId}
                manifest={masterManifest}
                onClick={() => setSelected(it.id)}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function ItemRow({
  item,
  active,
  manifest,
  onClick,
}: {
  item: InventoryItem;
  active: boolean;
  manifest: Manifest | null;
  onClick: () => void;
}) {
  const scopeLabel = item.scope === "global" ? "global" : "project";
  const projectLabel =
    item.scope === "project" && item.projectPath ? ` · ${basename(item.projectPath)}` : "";
  const state = manifest && !item.masterOnly ? masterStateFor(manifest, item) : null;
  const toolLabel =
    item.tool === MASTER_TOOL_SENTINEL ? "Master" : displayNameOf(item.tool);
  return (
    <div
      className={`artifact-card ${active ? "active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="artifact-name">
        <span>{item.name}</span>
        {item.masterOnly && (
          <span className="badge master-in-sync" title="In master · live source missing">
            master only
          </span>
        )}
        {state?.kind === "in-sync" && (
          <span className="badge master-in-sync" title="In master, in sync">
            ✓ master
          </span>
        )}
        {state?.kind === "drifted" && (
          <span className="badge master-drift" title="In master but source has drifted">
            drift
          </span>
        )}
      </div>
      <div className="artifact-desc">
        {toolLabel} · {scopeLabel}
        {projectLabel}
      </div>
      <div className="artifact-meta">
        <span title={item.absPath}>{shortPath(item.absPath)}</span>
      </div>
    </div>
  );
}

function basename(p: string): string {
  const segs = p.replace(/\/+$/, "").split(/[\\/]/);
  return segs[segs.length - 1] || p;
}


function shortPath(p: string): string {
  // Collapse the home prefix so the meta line stays tight in the list.
  const homeMatch = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)/);
  if (homeMatch) return p.replace(homeMatch[0], "~");
  return p;
}

// Workbench-level actions: open master folder, bulk restore, merge MCP,
// export/import zip. These are workspace-wide — they don't act on a
// selected inventory item — so they live in their own component instead
// of bloating InventoryList.

import { useEffect, useState } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { save as saveDialog, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { ensureDir } from "../lib/fs";
import { resolveMasterRoot } from "../lib/master/store";
import { importMasterZip, packMasterZip } from "../lib/master/export";
import { BulkRestoreDialog } from "./BulkRestoreDialog";
import { LockfileImportDialog } from "./LockfileImportDialog";
import { MergeMcpDialog } from "./MergeMcpDialog";

export function WorkbenchToolbar() {
  const { t } = useTranslation();
  const masterRoot = useApp((s) => s.masterRoot);
  const masterManifest = useApp((s) => s.masterManifest);
  const backupDestination = useApp((s) => s.backupDestination);
  const inventory = useApp((s) => s.workbenchInventory);
  const bumpScan = useApp((s) => s.bumpWorkbenchScan);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [lockfileImportOpen, setLockfileImportOpen] = useState(false);
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function flashToast(text: string) {
    setToast(text);
    setTimeout(() => setToast(null), 4000);
  }

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
      if (typeof target !== "string") return;
      if (!tauriFs.writeFile) {
        flashToast(t("workbenchToolbar.binaryWriteUnavailable"));
        return;
      }
      await tauriFs.writeFile(target, bytes);
      flashToast(t("workbenchToolbar.exportedToast", { target }));
    } catch (e) {
      flashToast(t("workbenchToolbar.exportFailed", { message: e instanceof Error ? e.message : String(e) }));
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
      if (typeof picked !== "string") return;
      if (!tauriFs.readFile) {
        flashToast(t("workbenchToolbar.binaryReadUnavailable"));
        return;
      }
      const bytes = await tauriFs.readFile(picked);
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      const result = await importMasterZip(tauriFs, tauriJoiner, root, bytes);
      const parts = [
        t("workbenchToolbar.importedFiles", { count: result.filesWritten + result.filesReplaced }),
      ];
      if (result.filesReplaced > 0) parts.push(t("workbenchToolbar.importedReplaced", { count: result.filesReplaced }));
      if (result.manifestEntriesImported > 0) {
        parts.push(t("workbenchToolbar.importedManifest", { count: result.manifestEntriesImported }));
      }
      flashToast(parts.join(" "));
      bumpScan();
    } catch (e) {
      flashToast(t("workbenchToolbar.importFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyImport(false);
    }
  }

  return (
    <>
      <ActionsMenu
        triggerLabel={t("workbenchToolbar.actionsTrigger")}
        items={[
          {
            label: t("workbenchToolbar.openMasterFolder"),
            onClick: openMasterFolder,
            hint: t("workbenchToolbar.openMasterFolderHint"),
          },
          {
            label: t("workbenchToolbar.bulkRestore"),
            onClick: () => setBulkOpen(true),
            disabled: !masterManifest || masterManifest.entries.length === 0,
            hint: t("workbenchToolbar.bulkRestoreHint"),
          },
          {
            label: t("workbenchToolbar.mergeMcp"),
            onClick: () => setMergeOpen(true),
            hint: t("workbenchToolbar.mergeMcpHint"),
          },
          { kind: "separator" },
          {
            label: busyExport ? t("workbenchToolbar.exportZipBusy") : t("workbenchToolbar.exportZip"),
            onClick: exportMasterZip,
            disabled: busyExport,
            hint: t("workbenchToolbar.exportZipHint"),
          },
          {
            label: busyImport ? t("workbenchToolbar.importZipBusy") : t("workbenchToolbar.importZip"),
            onClick: importMasterZipUI,
            disabled: busyImport,
            hint: t("workbenchToolbar.importZipHint"),
          },
          { kind: "separator" },
          {
            label: t("workbenchToolbar.importLockfile"),
            onClick: () => setLockfileImportOpen(true),
            hint: t("workbenchToolbar.importLockfileHint"),
          },
        ]}
      />
      {toast && <div className="workbench-list-toast">{toast}</div>}
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
      <LockfileImportDialog
        open={lockfileImportOpen}
        onClose={() => setLockfileImportOpen(false)}
        onImported={() => bumpScan()}
        onToast={(_kind, text) => flashToast(text)}
      />
    </>
  );
}

type ActionsMenuItem =
  | {
      kind?: "item";
      label: string;
      onClick: () => void;
      disabled?: boolean;
      hint?: string;
    }
  | { kind: "separator" };

function ActionsMenu({ items, triggerLabel }: { items: ActionsMenuItem[]; triggerLabel: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt?.closest(".workbench-actions-menu")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="workbench-actions-menu">
      <button
        type="button"
        className="link-btn workbench-actions-menu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        {triggerLabel}
      </button>
      {open && (
        <div role="menu" className="workbench-actions-menu-popover">
          {items.map((item, i) => {
            if ("kind" in item && item.kind === "separator") {
              return <div key={`sep-${i}`} className="workbench-actions-menu-sep" />;
            }
            const it = item as Extract<ActionsMenuItem, { label: string }>;
            return (
              <button
                key={it.label}
                role="menuitem"
                type="button"
                className="workbench-actions-menu-item"
                disabled={it.disabled}
                title={it.hint}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                <span className="workbench-actions-menu-label">{it.label}</span>
                {it.hint && (
                  <span className="workbench-actions-menu-hint">{it.hint}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

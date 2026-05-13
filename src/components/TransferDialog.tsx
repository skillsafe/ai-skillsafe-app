// TransferDialog — port a memory item from one tool's format to another.
//
// Source is preset from whatever the user clicked in the Workbench. The
// dialog lets them pick destination tool / scope / project / filename
// and shows a live preview of the translated payload before writing.
// Overwrite-mode chooses replace / append / skip-if-exists.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { displayNameOf } from "../lib/agents/registry";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import {
  MEMORY_GLOBAL_CAPABLE,
  MEMORY_TRANSFER_TARGETS,
  previewMemoryTransfer,
  resolveMemoryDestPath,
  transferMemory,
  type MemoryDestination,
  type TransferMode,
} from "../lib/translate/memory";
import {
  MCP_GLOBAL_CAPABLE,
  MCP_TRANSFER_TARGETS,
  isMcpTransferTool,
  previewMcpTransfer,
  resolveMcpDestPath,
  transferMcp,
  type McpDestination,
  type McpTransferMode,
} from "../lib/translate/mcp";
import type { McpServer } from "../lib/configs/schemas";
import type { InventoryItem, WorkbenchScope } from "../lib/inventory/types";
import { bindSource, loadManifest, resolveMasterRoot } from "../lib/master/store";
import { sha256Hex } from "../lib/fs";

interface Props {
  source: InventoryItem;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

const MEMORY_MODE_IDS: TransferMode[] = ["replace", "append", "skip-if-exists"];
const MCP_MODE_IDS: McpTransferMode[] = ["replace", "skip-if-exists"];

export function TransferDialog({ source, onClose, onSuccess, onError }: Props) {
  const { t } = useTranslation();
  const memoryModeOptions = useMemo(() => [
    { id: "replace" as TransferMode, label: t("transferDialog.modeReplace"), description: t("transferDialog.modeReplaceMemoryDesc") },
    { id: "append" as TransferMode, label: t("transferDialog.modeAppend"), description: t("transferDialog.modeAppendDesc") },
    { id: "skip-if-exists" as TransferMode, label: t("transferDialog.modeSkipIfExists"), description: t("transferDialog.modeSkipMemoryDesc") },
  ], [t]);
  const mcpModeOptions = useMemo(() => [
    { id: "replace" as McpTransferMode, label: t("transferDialog.modeReplace"), description: t("transferDialog.modeReplaceMcpDesc") },
    { id: "skip-if-exists" as McpTransferMode, label: t("transferDialog.modeSkipIfExists"), description: t("transferDialog.modeSkipMcpDesc") },
  ], [t]);
  const recentProjects = useApp((s) => s.recentProjects);
  const projectRoot = useApp((s) => s.projectRoot);
  const bumpWorkbenchScan = useApp((s) => s.bumpWorkbenchScan);
  const masterRoot = useApp((s) => s.masterRoot);
  const masterManifest = useApp((s) => s.masterManifest);
  const setMasterManifest = useApp((s) => s.setMasterManifest);
  const backupDestination = useApp((s) => s.backupDestination);

  // Bind the destination as an additional source of the master entry on
  // success. Only meaningful when the source itself is in master (so the
  // entry actually exists).
  const sourceInMaster = !!masterManifest?.entries.find((e) => e.id === source.id);
  const [bindOnTransfer, setBindOnTransfer] = useState<boolean>(sourceInMaster);

  const isMcp = source.category === "mcp";
  const supportedTargets = isMcp ? MCP_TRANSFER_TARGETS : MEMORY_TRANSFER_TARGETS;
  const globalCapableSet = isMcp ? MCP_GLOBAL_CAPABLE : MEMORY_GLOBAL_CAPABLE;
  const modeOptions = isMcp ? mcpModeOptions : memoryModeOptions;
  // Mode id list kept for any caller that walks the original constants.
  void MEMORY_MODE_IDS; void MCP_MODE_IDS;

  // Default destination tool: pick one supported tool that isn't the source.
  const defaultDestTool =
    (supportedTargets as readonly string[]).find((t) => t !== source.tool) ??
    supportedTargets[0];
  const [destTool, setDestTool] = useState<string>(defaultDestTool);
  const [destScope, setDestScope] = useState<WorkbenchScope>(
    source.scope === "global" && globalCapableSet.has(defaultDestTool)
      ? "global"
      : "project",
  );
  const [destProject, setDestProject] = useState<string | null>(
    source.scope === "project" && source.projectPath
      ? source.projectPath
      : projectRoot ?? recentProjects[0] ?? null,
  );
  const [fileNameOverride, setFileNameOverride] = useState<string>("");
  const [memoryMode, setMemoryMode] = useState<TransferMode>("replace");
  const [mcpMode, setMcpMode] = useState<McpTransferMode>("replace");
  const [resolvedPath, setResolvedPath] = useState<string>("");
  const [resolveWarnings, setResolveWarnings] = useState<string[]>([]);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [mcpPreview, setMcpPreview] = useState<string>("");

  const sourceBody = useMemo(() => {
    if (source.payload && typeof source.payload === "object" && "body" in source.payload) {
      return String((source.payload as { body: unknown }).body ?? "");
    }
    return "";
  }, [source]);

  const memoryPreview = useMemo(() => {
    if (isMcp) return "";
    return previewMemoryTransfer({
      sourceTool: source.tool,
      sourceName: source.name,
      sourceBody,
      destTool,
    });
  }, [isMcp, source, sourceBody, destTool]);

  const supportsGlobal = globalCapableSet.has(destTool);
  const requiresProject = isMcp
    ? destTool !== "codex" && (destScope === "project" || destTool === "cursor")
    : destScope === "project" || destTool === "cursor" || destTool === "cline";
  const fileNameApplicable = isMcp || destTool === "cursor" || destTool === "cline";
  const fileNameLabel = isMcp ? t("transferDialog.serverNameLabel") : t("transferDialog.filenameLabel");

  // Auto-coerce destination scope when switching to a tool that doesn't
  // support global memory.
  useEffect(() => {
    if (destScope === "global" && !supportsGlobal) {
      setDestScope("project");
    }
  }, [destScope, supportsGlobal]);

  // Resolve the destination path live so the user can see exactly where
  // the file will land. Branches on category — memory and MCP each have
  // their own resolver.
  useEffect(() => {
    let cancelled = false;
    setResolveError(null);
    if (requiresProject && !destProject) {
      setResolvedPath("");
      setResolveWarnings([]);
      setResolveError(t("transferDialog.pickProjectRoot"));
      return;
    }
    (async () => {
      try {
        if (isMcp) {
          if (!isMcpTransferTool(destTool)) {
            throw new Error(t("transferDialog.mcpNotSupported", { tool: destTool }));
          }
          const dest: McpDestination = {
            tool: destTool,
            scope: destScope,
            projectRoot: destProject ?? undefined,
            nameOverride: fileNameOverride || source.name,
          };
          const r = await resolveMcpDestPath(tauriPaths, tauriJoiner, dest);
          if (cancelled) return;
          setResolvedPath(r.path);
          setResolveWarnings(r.warnings);
          // Generate the JSON/TOML preview for MCP. previewMcpTransfer
          // reads the destination, so we keep this inside the same
          // effect so it re-runs when inputs change.
          const sourceServer = (source.payload ?? {}) as McpServer;
          const previewResult = await previewMcpTransfer(
            tauriFs,
            tauriPaths,
            tauriJoiner,
            {
              sourceTool: source.tool,
              sourceName: source.name,
              sourceServer,
              dest,
              mode: mcpMode,
            },
          );
          if (cancelled) return;
          setMcpPreview(previewResult.content);
        } else {
          const dest: MemoryDestination = {
            tool: destTool,
            scope: destScope,
            projectRoot: destProject ?? undefined,
            fileName: fileNameOverride || source.name,
          };
          const r = await resolveMemoryDestPath(tauriFs, tauriPaths, tauriJoiner, dest);
          if (cancelled) return;
          setResolvedPath(r.path);
          setResolveWarnings(r.warnings);
        }
      } catch (e) {
        if (cancelled) return;
        setResolvedPath("");
        setResolveWarnings([]);
        setResolveError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isMcp,
    destTool,
    destScope,
    destProject,
    fileNameOverride,
    mcpMode,
    source,
    requiresProject,
    t,
  ]);

  async function handleConfirm() {
    if (resolveError) return;
    setBusy(true);
    try {
      if (isMcp) {
        if (!isMcpTransferTool(destTool)) {
          throw new Error(t("transferDialog.mcpNotSupported", { tool: destTool }));
        }
        const dest: McpDestination = {
          tool: destTool,
          scope: destScope,
          projectRoot: destProject ?? undefined,
          nameOverride: fileNameOverride || source.name,
        };
        const sourceServer = (source.payload ?? {}) as McpServer;
        const result = await transferMcp(tauriFs, tauriPaths, tauriJoiner, {
          sourceTool: source.tool,
          sourceName: source.name,
          sourceServer,
          dest,
          mode: mcpMode,
        });
        bumpWorkbenchScan();
        if (bindOnTransfer && sourceInMaster && !result.skipped) {
          await maybeBind({
            tool: destTool,
            scope: destScope,
            projectPath: destProject ?? null,
            absPath: result.destPath,
            // MCP: hash the JSON we just wrote so the bind starts in-sync.
            syncedContent: JSON.stringify(sourceServer),
          });
        }
        const lines = [
          result.skipped
            ? t("transferDialog.mcpSkippedToast", { name: result.writtenName, path: result.destPath })
            : t("transferDialog.mcpTransferredToast", { name: result.writtenName, path: result.destPath }),
        ];
        if (result.backupPath) lines.push(t("transferDialog.backupSavedFile", { path: result.backupPath }));
        for (const w of result.warnings) lines.push(w);
        onSuccess(lines.join(" "));
        onClose();
        return;
      }
      const dest: MemoryDestination = {
        tool: destTool,
        scope: destScope,
        projectRoot: destProject ?? undefined,
        fileName: fileNameOverride || source.name,
      };
      const result = await transferMemory(tauriFs, tauriPaths, tauriJoiner, {
        sourceTool: source.tool,
        sourceName: source.name,
        sourceBody,
        dest,
        mode: memoryMode,
      });
      bumpWorkbenchScan();
      if (bindOnTransfer && sourceInMaster && !result.skipped) {
        await maybeBind({
          tool: destTool,
          scope: destScope,
          projectPath: destProject ?? null,
          absPath: result.destPath,
          // Memory: hash exactly what we wrote (post-translation), since
          // that's what masterStateFor will compare against on the next
          // scan.
          syncedContent: result.written ?? "",
        });
      }
      const lines = [
        result.skipped
          ? t("transferDialog.memorySkippedToast", { path: result.destPath })
          : t("transferDialog.memoryTransferredToast", { path: result.destPath }),
      ];
      if (result.backupPath) lines.push(t("transferDialog.backupSavedContent", { path: result.backupPath }));
      for (const w of result.warnings) lines.push(w);
      onSuccess(lines.join(" "));
      onClose();
    } catch (e) {
      onError(t("transferDialog.transferFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function maybeBind(args: {
    tool: string;
    scope: WorkbenchScope;
    projectPath: string | null;
    absPath: string;
    syncedContent: string;
  }) {
    try {
      const root = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
      const syncedHash = await sha256Hex(args.syncedContent);
      await bindSource(tauriFs, tauriJoiner, root, source.id, {
        tool: args.tool,
        scope: args.scope,
        projectPath: args.projectPath,
        absPath: args.absPath,
        syncedHash,
      });
      // Refresh the manifest so the SourcesList in Workbench picks up the
      // new bound source immediately.
      const next = await loadManifest(tauriFs, tauriJoiner, root);
      setMasterManifest(next);
    } catch {
      // Bind is opportunistic — the transfer itself already succeeded.
      // Silently swallow so the user doesn't see a confusing "transfer
      // worked but bind failed" toast.
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="dialog transfer-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="transfer-header">
          <h3 style={{ margin: 0 }}>
            {isMcp ? t("transferDialog.titleMcp") : t("transferDialog.titleMemory")}
          </h3>
          <button
            className="icon-btn"
            aria-label={t("transferDialog.closeAria")}
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </header>
        <div className="transfer-body">
          <section className="transfer-section">
            <div className="transfer-label">{t("transferDialog.sourceSection")}</div>
            <div className="transfer-source-summary">
              <code>{source.absPath}</code>
              <div className="muted">
                {displayNameOf(source.tool)} · {source.category} · {source.scope}
                {source.projectPath ? ` · ${shortenPath(source.projectPath)}` : ""}
              </div>
            </div>
          </section>

          <section className="transfer-section">
            <div className="transfer-label">{t("transferDialog.destinationSection")}</div>
            <div className="transfer-grid">
              <label>
                <span>{t("transferDialog.destTool")}</span>
                <select
                  value={destTool}
                  onChange={(e) => setDestTool(e.target.value)}
                >
                  {supportedTargets.map((tt) => (
                    <option key={tt} value={tt}>
                      {displayNameOf(tt)}
                      {tt === source.tool ? t("transferDialog.destSourceSuffix") : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("transferDialog.destScope")}</span>
                <div className="pill-row" role="tablist" aria-label={t("transferDialog.destScopeAria")}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={destScope === "global"}
                    className={`pill ${destScope === "global" ? "active" : ""}`}
                    disabled={!supportsGlobal}
                    onClick={() => setDestScope("global")}
                  >
                    {t("transferDialog.destGlobal")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={destScope === "project"}
                    className={`pill ${destScope === "project" ? "active" : ""}`}
                    onClick={() => setDestScope("project")}
                  >
                    {t("transferDialog.destProject")}
                  </button>
                </div>
              </label>
              {requiresProject && (
                <label>
                  <span>{t("transferDialog.projectSelectLabel")}</span>
                  <select
                    value={destProject ?? ""}
                    onChange={(e) => setDestProject(e.target.value || null)}
                  >
                    <option value="">{t("transferDialog.pickProject")}</option>
                    {recentProjects.map((p) => (
                      <option key={p} value={p}>
                        {shortenPath(p)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {fileNameApplicable && (
                <label>
                  <span>{fileNameLabel}</span>
                  <input
                    type="text"
                    value={fileNameOverride}
                    placeholder={source.name}
                    onChange={(e) => setFileNameOverride(e.target.value)}
                  />
                </label>
              )}
            </div>
            <div className="transfer-resolved-path">
              {resolveError ? (
                <span className="transfer-error">{resolveError}</span>
              ) : resolvedPath ? (
                <code>{resolvedPath}</code>
              ) : (
                <span className="muted">{t("transferDialog.resolving")}</span>
              )}
            </div>
            {resolveWarnings.length > 0 && (
              <ul className="transfer-warnings">
                {resolveWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="transfer-section">
            <div className="transfer-label">
              {isMcp ? t("transferDialog.modeSectionMcp") : t("transferDialog.modeSectionMemory")}
            </div>
            <div className="pill-row" role="radiogroup" aria-label={t("transferDialog.modeAria")}>
              {modeOptions.map((opt) => {
                const active = isMcp ? mcpMode === opt.id : memoryMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`pill ${active ? "active" : ""}`}
                    onClick={() => {
                      if (isMcp) setMcpMode(opt.id as McpTransferMode);
                      else setMemoryMode(opt.id as TransferMode);
                    }}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <div className="muted transfer-mode-hint">
              {(modeOptions as ReadonlyArray<{ id: string; description: string }>).find(
                (o) => o.id === (isMcp ? mcpMode : memoryMode),
              )?.description}
            </div>
          </section>

          {sourceInMaster && (
            <section className="transfer-section">
              <label
                className="transfer-bind-row"
                title={t("transferDialog.bindTitle")}
              >
                <input
                  type="checkbox"
                  checked={bindOnTransfer}
                  onChange={(e) => setBindOnTransfer(e.target.checked)}
                  data-testid="bind-on-transfer"
                />
                <span>{t("transferDialog.bindLabel")}</span>
              </label>
            </section>
          )}

          <section className="transfer-section">
            <div className="transfer-label-row">
              <div className="transfer-label">{t("transferDialog.previewSection")}</div>
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowPreview((v) => !v)}
              >
                {showPreview ? t("transferDialog.hide") : t("transferDialog.show")}
              </button>
            </div>
            {showPreview && (
              <pre className="workbench-payload workbench-payload-text transfer-preview">
                {(isMcp ? mcpPreview : memoryPreview) || t("transferDialog.emptyPreview")}
              </pre>
            )}
          </section>
        </div>
        <div className="dialog-row">
          <button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className="primary"
            onClick={handleConfirm}
            disabled={busy || !!resolveError || !resolvedPath}
          >
            {busy ? t("transferDialog.transferring") : t("transferDialog.transferButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortenPath(p: string): string {
  const home = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)/);
  if (home) return p.replace(home[0], "~");
  return p;
}

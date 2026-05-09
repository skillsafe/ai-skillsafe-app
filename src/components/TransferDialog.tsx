// TransferDialog — port a memory item from one tool's format to another.
//
// Source is preset from whatever the user clicked in the Workbench. The
// dialog lets them pick destination tool / scope / project / filename
// and shows a live preview of the translated payload before writing.
// Overwrite-mode chooses replace / append / skip-if-exists.

import { useEffect, useMemo, useState } from "react";
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
  type McpTransferTool,
} from "../lib/translate/mcp";
import type { McpServer } from "../lib/configs/schemas";
import type { InventoryItem, WorkbenchScope } from "../lib/inventory/types";

interface Props {
  source: InventoryItem;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

const MEMORY_MODE_OPTIONS: Array<{ id: TransferMode; label: string; description: string }> = [
  {
    id: "replace",
    label: "Replace",
    description: "Overwrite the destination. A .skillsafe.bak copy is kept beside it.",
  },
  {
    id: "append",
    label: "Append",
    description: "Append to the existing destination, separated by a horizontal rule.",
  },
  {
    id: "skip-if-exists",
    label: "Skip if exists",
    description: "Only write when the destination doesn't exist yet.",
  },
];

const MCP_MODE_OPTIONS: Array<{ id: McpTransferMode; label: string; description: string }> = [
  {
    id: "replace",
    label: "Replace",
    description: "Overwrite the server entry if it already exists; siblings are preserved.",
  },
  {
    id: "skip-if-exists",
    label: "Skip if exists",
    description: "Only write when no server with this name exists yet at the destination.",
  },
];

export function TransferDialog({ source, onClose, onSuccess, onError }: Props) {
  const recentProjects = useApp((s) => s.recentProjects);
  const projectRoot = useApp((s) => s.projectRoot);
  const bumpWorkbenchScan = useApp((s) => s.bumpWorkbenchScan);

  const isMcp = source.category === "mcp";
  const supportedTargets = isMcp ? MCP_TRANSFER_TARGETS : MEMORY_TRANSFER_TARGETS;
  const globalCapableSet = isMcp ? MCP_GLOBAL_CAPABLE : MEMORY_GLOBAL_CAPABLE;
  const modeOptions = isMcp ? MCP_MODE_OPTIONS : MEMORY_MODE_OPTIONS;

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
  const fileNameLabel = isMcp ? "Server name" : "Filename";

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
      setResolveError("Pick a project root.");
      return;
    }
    (async () => {
      try {
        if (isMcp) {
          if (!isMcpTransferTool(destTool)) {
            throw new Error(`MCP transfer to ${destTool} is not supported.`);
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
  ]);

  async function handleConfirm() {
    if (resolveError) return;
    setBusy(true);
    try {
      if (isMcp) {
        if (!isMcpTransferTool(destTool)) {
          throw new Error(`MCP transfer to ${destTool} is not supported.`);
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
        const lines = [
          result.skipped
            ? `Skipped: ${result.writtenName} already exists at ${result.destPath}.`
            : `Transferred ${result.writtenName} → ${result.destPath}`,
        ];
        if (result.backupPath) lines.push(`Previous file saved to ${result.backupPath}.`);
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
      const lines = [
        result.skipped
          ? `Skipped: destination already exists (${result.destPath}).`
          : `Transferred to ${result.destPath}`,
      ];
      if (result.backupPath) lines.push(`Previous content saved to ${result.backupPath}.`);
      for (const w of result.warnings) lines.push(w);
      onSuccess(lines.join(" "));
      onClose();
    } catch (e) {
      onError(`Transfer failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
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
            Transfer {isMcp ? "MCP server" : "memory"} to another tool
          </h3>
          <button
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </header>
        <div className="transfer-body">
          <section className="transfer-section">
            <div className="transfer-label">Source</div>
            <div className="transfer-source-summary">
              <code>{source.absPath}</code>
              <div className="muted">
                {displayNameOf(source.tool)} · {source.category} · {source.scope}
                {source.projectPath ? ` · ${shortenPath(source.projectPath)}` : ""}
              </div>
            </div>
          </section>

          <section className="transfer-section">
            <div className="transfer-label">Destination</div>
            <div className="transfer-grid">
              <label>
                <span>Tool</span>
                <select
                  value={destTool}
                  onChange={(e) => setDestTool(e.target.value)}
                >
                  {supportedTargets.map((t) => (
                    <option key={t} value={t}>
                      {displayNameOf(t)}
                      {t === source.tool ? " (source)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Scope</span>
                <div className="pill-row" role="tablist" aria-label="Destination scope">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={destScope === "global"}
                    className={`pill ${destScope === "global" ? "active" : ""}`}
                    disabled={!supportsGlobal}
                    onClick={() => setDestScope("global")}
                  >
                    Global
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={destScope === "project"}
                    className={`pill ${destScope === "project" ? "active" : ""}`}
                    onClick={() => setDestScope("project")}
                  >
                    Project
                  </button>
                </div>
              </label>
              {requiresProject && (
                <label>
                  <span>Project</span>
                  <select
                    value={destProject ?? ""}
                    onChange={(e) => setDestProject(e.target.value || null)}
                  >
                    <option value="">— pick a project —</option>
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
                <span className="muted">Resolving…</span>
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
              {isMcp ? "If a server with this name exists" : "If destination exists"}
            </div>
            <div className="pill-row" role="radiogroup" aria-label="Overwrite mode">
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

          <section className="transfer-section">
            <div className="transfer-label-row">
              <div className="transfer-label">Preview</div>
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowPreview((v) => !v)}
              >
                {showPreview ? "Hide" : "Show"}
              </button>
            </div>
            {showPreview && (
              <pre className="workbench-payload workbench-payload-text transfer-preview">
                {(isMcp ? mcpPreview : memoryPreview) || "(empty)"}
              </pre>
            )}
          </section>
        </div>
        <div className="dialog-row">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={handleConfirm}
            disabled={busy || !!resolveError || !resolvedPath}
          >
            {busy ? "Transferring…" : "Transfer"}
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

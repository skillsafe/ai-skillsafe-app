// MergeMcpDialog — side-by-side comparison of two tools' MCP server
// lists. Rows are the union of server names across both sides; for each
// missing-on-one-side row the user can copy-across with one click.
//
// PR 4 deliverable: pairs up cleanly with the per-item Transfer in the
// detail pane for the case where the user wants to bulk-merge instead.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useApp } from "../lib/store";
import { displayNameOf } from "../lib/agents/registry";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import {
  MCP_GLOBAL_CAPABLE,
  MCP_TRANSFER_TARGETS,
  isMcpTransferTool,
  transferMcp,
  type McpTransferTool,
} from "../lib/translate/mcp";
import type { McpServer } from "../lib/configs/schemas";
import type { InventoryItem, WorkbenchScope } from "../lib/inventory/types";

interface Props {
  /** Inventory items to draw the union from — passed in by the caller so
   *  the dialog doesn't re-scan. */
  items: ReadonlyArray<InventoryItem>;
  onClose: () => void;
  onSuccess: (text: string) => void;
  onError: (text: string) => void;
}

interface SideKey {
  tool: McpTransferTool;
  scope: WorkbenchScope;
  /** project root for project-scope sides */
  projectRoot?: string;
}

interface UnionRow {
  name: string;
  left: McpServer | null;
  right: McpServer | null;
}

export function MergeMcpDialog({ items, onClose, onSuccess, onError }: Props) {
  const { t } = useTranslation();
  const recentProjects = useApp((s) => s.recentProjects);
  const projectRoot = useApp((s) => s.projectRoot);
  const bumpScan = useApp((s) => s.bumpWorkbenchScan);

  const [leftTool, setLeftTool] = useState<McpTransferTool>("claude");
  const [leftScope, setLeftScope] = useState<WorkbenchScope>("global");
  const [leftProject, setLeftProject] = useState<string | null>(
    projectRoot ?? recentProjects[0] ?? null,
  );
  const [rightTool, setRightTool] = useState<McpTransferTool>(
    MCP_TRANSFER_TARGETS.find((t) => t !== "claude") ?? "codex",
  );
  const [rightScope, setRightScope] = useState<WorkbenchScope>("global");
  const [rightProject, setRightProject] = useState<string | null>(
    projectRoot ?? recentProjects[0] ?? null,
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bannerToast, setBannerToast] = useState<string | null>(null);

  // Coerce scope when the picked tool can't host project (or global).
  useEffect(() => {
    if (!MCP_GLOBAL_CAPABLE.has(leftTool) && leftScope === "global") setLeftScope("project");
    if (leftTool === "codex") setLeftScope("global");
  }, [leftTool, leftScope]);
  useEffect(() => {
    if (!MCP_GLOBAL_CAPABLE.has(rightTool) && rightScope === "global") setRightScope("project");
    if (rightTool === "codex") setRightScope("global");
  }, [rightTool, rightScope]);

  function matchesSide(item: InventoryItem, side: SideKey): boolean {
    if (item.category !== "mcp") return false;
    if (item.tool !== side.tool) return false;
    if (item.scope !== side.scope) return false;
    if (side.scope === "project") {
      return item.projectPath === (side.projectRoot ?? null);
    }
    return true;
  }

  const leftSide: SideKey = useMemo(
    () => ({ tool: leftTool, scope: leftScope, projectRoot: leftProject ?? undefined }),
    [leftTool, leftScope, leftProject],
  );
  const rightSide: SideKey = useMemo(
    () => ({ tool: rightTool, scope: rightScope, projectRoot: rightProject ?? undefined }),
    [rightTool, rightScope, rightProject],
  );

  const rows: UnionRow[] = useMemo(() => {
    const leftMap = new Map<string, McpServer>();
    const rightMap = new Map<string, McpServer>();
    for (const it of items) {
      if (matchesSide(it, leftSide)) leftMap.set(it.name, it.payload as McpServer);
      if (matchesSide(it, rightSide)) rightMap.set(it.name, it.payload as McpServer);
    }
    const names = new Set<string>([...leftMap.keys(), ...rightMap.keys()]);
    return Array.from(names)
      .sort()
      .map((name) => ({
        name,
        left: leftMap.get(name) ?? null,
        right: rightMap.get(name) ?? null,
      }));
  }, [items, leftSide, rightSide]);

  async function copyAcross(
    direction: "left-to-right" | "right-to-left",
    row: UnionRow,
  ) {
    const key = `${direction}:${row.name}`;
    setBusyKey(key);
    try {
      const sourceServer = direction === "left-to-right" ? row.left : row.right;
      if (!sourceServer) {
        onError(t("mergeMcp.sourceEmpty", { name: row.name }));
        return;
      }
      const dest = direction === "left-to-right" ? rightSide : leftSide;
      const sourceTool =
        direction === "left-to-right" ? leftSide.tool : rightSide.tool;
      if (dest.scope === "project" && !dest.projectRoot) {
        onError(t("mergeMcp.pickProjectRoot"));
        return;
      }
      const result = await transferMcp(tauriFs, tauriPaths, tauriJoiner, {
        sourceTool,
        sourceName: row.name,
        sourceServer,
        dest: {
          tool: dest.tool,
          scope: dest.scope,
          projectRoot: dest.projectRoot,
          nameOverride: row.name,
        },
        mode: "replace",
      });
      bumpScan();
      const msg = t("mergeMcp.copiedToast", { name: row.name, path: result.destPath });
      setBannerToast(msg);
      onSuccess(msg);
    } catch (e) {
      onError(t("mergeMcp.copyFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={busyKey ? undefined : onClose}
    >
      <div
        className="dialog merge-mcp-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="transfer-header">
          <h3 style={{ margin: 0 }}>{t("mergeMcp.title")}</h3>
          <button className="icon-btn" aria-label={t("mergeMcp.closeAria")} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="merge-body">
          <div className="merge-sides">
            <SidePicker
              label={t("mergeMcp.sideA")}
              tool={leftTool}
              scope={leftScope}
              projectRoot={leftProject}
              recentProjects={recentProjects}
              onTool={(tt) => setLeftTool(tt)}
              onScope={setLeftScope}
              onProject={setLeftProject}
              t={t}
            />
            <SidePicker
              label={t("mergeMcp.sideB")}
              tool={rightTool}
              scope={rightScope}
              projectRoot={rightProject}
              recentProjects={recentProjects}
              onTool={(tt) => setRightTool(tt)}
              onScope={setRightScope}
              onProject={setRightProject}
              t={t}
            />
          </div>
          {bannerToast && <div className="workbench-list-toast">{bannerToast}</div>}
          {rows.length === 0 ? (
            <div className="muted bulk-empty">
              {t("mergeMcp.empty")}
            </div>
          ) : (
            <ul className="merge-rows">
              {rows.map((row) => {
                const leftMissing = !row.left;
                const rightMissing = !row.right;
                const leftBusy = busyKey === `right-to-left:${row.name}`;
                const rightBusy = busyKey === `left-to-right:${row.name}`;
                return (
                  <li key={row.name} className="merge-row">
                    <div className="merge-cell merge-name">{row.name}</div>
                    <div className="merge-cell merge-left">
                      {row.left ? t("mergeMcp.present") : <span className="muted">{t("mergeMcp.missing")}</span>}
                    </div>
                    <div className="merge-cell merge-arrows">
                      <button
                        type="button"
                        disabled={!row.left || rightBusy}
                        onClick={() => copyAcross("left-to-right", row)}
                        title={t("mergeMcp.copyTitle", { name: row.name, from: displayNameOf(leftTool), to: displayNameOf(rightTool) })}
                      >
                        {rightBusy ? "…" : "→"}
                      </button>
                      <button
                        type="button"
                        disabled={!row.right || leftBusy}
                        onClick={() => copyAcross("right-to-left", row)}
                        title={t("mergeMcp.copyTitle", { name: row.name, from: displayNameOf(rightTool), to: displayNameOf(leftTool) })}
                      >
                        {leftBusy ? "…" : "←"}
                      </button>
                    </div>
                    <div className="merge-cell merge-right">
                      {row.right ? t("mergeMcp.present") : <span className="muted">{t("mergeMcp.missing")}</span>}
                    </div>
                    <div className="merge-cell merge-status">
                      {leftMissing && rightMissing
                        ? ""
                        : leftMissing
                          ? t("mergeMcp.onlyInTool", { tool: displayNameOf(rightTool) })
                          : rightMissing
                            ? t("mergeMcp.onlyInTool", { tool: displayNameOf(leftTool) })
                            : sameServer(row.left!, row.right!)
                              ? t("mergeMcp.inSync")
                              : t("mergeMcp.differs")}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="dialog-row">
          <button onClick={onClose}>{t("mergeMcp.done")}</button>
        </div>
      </div>
    </div>
  );
}

function sameServer(a: McpServer, b: McpServer): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function SidePicker({
  label,
  tool,
  scope,
  projectRoot,
  recentProjects,
  onTool,
  onScope,
  onProject,
  t,
}: {
  label: string;
  tool: McpTransferTool;
  scope: WorkbenchScope;
  projectRoot: string | null;
  recentProjects: string[];
  onTool: (t: McpTransferTool) => void;
  onScope: (s: WorkbenchScope) => void;
  onProject: (p: string | null) => void;
  t: TFunction;
}) {
  return (
    <div className="merge-side">
      <div className="transfer-label">{label}</div>
      <select
        value={tool}
        onChange={(e) => {
          const v = e.target.value;
          if (isMcpTransferTool(v)) onTool(v);
        }}
      >
        {MCP_TRANSFER_TARGETS.map((tt) => (
          <option key={tt} value={tt}>
            {displayNameOf(tt)}
          </option>
        ))}
      </select>
      <div className="pill-row">
        <button
          type="button"
          className={`pill ${scope === "global" ? "active" : ""}`}
          disabled={!MCP_GLOBAL_CAPABLE.has(tool)}
          onClick={() => onScope("global")}
        >
          {t("mergeMcp.global")}
        </button>
        <button
          type="button"
          className={`pill ${scope === "project" ? "active" : ""}`}
          disabled={tool === "codex"}
          onClick={() => onScope("project")}
        >
          {t("mergeMcp.project")}
        </button>
      </div>
      {scope === "project" && (
        <select
          value={projectRoot ?? ""}
          onChange={(e) => onProject(e.target.value || null)}
        >
          <option value="">{t("mergeMcp.pickProject")}</option>
          {recentProjects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// Settings list — middle pane when type === "settings".
//
// Master-saveable files (CLAUDE.md, settings.json, .mcp.json, hooks,
// permissions, keybindings) detected by the inventory scanner, plus any
// master-only entries with no live source. Rendered in the standard
// list-pane shell to mirror the Skills/Agents/Commands experience.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { displayNameOf } from "../lib/agents/registry";
import { masterStateFor } from "../lib/master/store";
import type { Manifest } from "../lib/master/types";
import type { InventoryItem } from "../lib/inventory/types";
import { EmptyStateGuidance } from "./EmptyStateGuidance";
import { LocationHeader } from "./LocationHeader";
import { useFilterCounts } from "../lib/hooks/useFilterCounts";

export const MASTER_TOOL_SENTINEL = "__master__";

export function InventoryList() {
  const { t } = useTranslation();
  const tool = useApp((s) => s.tool);
  const scope = useApp((s) => s.scope);
  const projectFilter = useApp((s) => s.projectFilter);
  const workbenchSelectedId = useApp((s) => s.workbenchSelectedId);
  const workbenchCategory = useApp((s) => s.workbenchCategory);
  const inventory = useApp((s) => s.workbenchInventory);
  const loading = useApp((s) => s.workbenchLoading);
  const error = useApp((s) => s.workbenchError);
  const masterManifest = useApp((s) => s.masterManifest);
  const masterItems = useApp((s) => s.masterItems);
  const setSelected = useApp((s) => s.setWorkbenchSelectedId);
  const bumpWorkbenchScan = useApp((s) => s.bumpWorkbenchScan);
  const counts = useFilterCounts();
  const [query, setQuery] = useState("");

  // Live items + master-only items with no matching live source,
  // de-duplicated by id (live wins). Then narrowed by the same Tool +
  // Scope + Project selectors that drive the artifact list, so the
  // Settings filter behaves like Skills/Agents/Commands. Master-only
  // orphans (tool === MASTER_TOOL_SENTINEL) are tool-agnostic and
  // always pass the tool filter.
  //
  // Scope semantics for Master (Workbench) view:
  //   - "all":      every scope passes; projectFilter narrows project-
  //                 scoped items to the picked project but keeps globals
  //                 (which apply across every project).
  //   - "global":   only global items.
  //   - "project":  only project-scoped items, optionally narrowed to one.
  const filtered = useMemo(() => {
    const live = inventory?.items ?? [];
    const liveIds = new Set(live.map((it) => it.id));
    const masterOnly = masterItems.filter((it) => !liveIds.has(it.id));
    const merged = [...live, ...masterOnly];
    const q = query.toLowerCase().trim();
    return merged.filter((it) => {
      if (it.tool !== MASTER_TOOL_SENTINEL && it.tool !== tool) return false;
      // Master category filter (TYPE row in Master view): when set, the
      // user has clicked Memory / MCP / Hooks / etc. and only that group
      // of master files should show.
      if (workbenchCategory && it.category !== workbenchCategory) return false;
      if (scope === "global" && it.scope !== "global") return false;
      if (scope === "project") {
        if (it.scope !== "project") return false;
        if (projectFilter && it.projectPath !== projectFilter) return false;
      }
      // Project refinement when scope isn't already constrained: lets the
      // Master view's project picker narrow project-scoped items without
      // hiding the globals the user almost always wants alongside.
      if (scope !== "global" && scope !== "project" && projectFilter) {
        if (it.scope === "project" && it.projectPath !== projectFilter) return false;
      }
      if (q) {
        // Match across name, on-disk path, tool key, and category so a
        // single typed term finds CLAUDE.md, ".mcp.json", "playwright",
        // "memory", etc.
        const hay = `${it.name} ${it.absPath} ${it.tool} ${it.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [inventory, masterItems, tool, scope, projectFilter, query, workbenchCategory]);

  return (
    <section className="list-pane">
      <LocationHeader />
      <div className="list-toolbar">
        <input
          className="search"
          placeholder={t("inventoryList.filterPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          onClick={() => bumpWorkbenchScan()}
          aria-label={t("inventoryList.rescanAria")}
          title={t("inventoryList.rescanTitle")}
          data-testid="inventory-list-refresh"
        >
          ↻
        </button>
      </div>
      {error && <div className="empty empty-error">{t("inventoryList.scanFailed", { error })}</div>}

      {!loading && inventory && filtered.length === 0 && !error && (
        <EmptyStateGuidance
          view="workbench"
          tool={tool}
          scope={scope}
          category={workbenchCategory}
          totalAcrossAll={inventory.items.filter((it) => it.tool === tool).length}
          broadenings={counts.broadenings}
        />
      )}

      {filtered.map((it) => (
        <ItemRow
          key={it.id}
          item={it}
          active={it.id === workbenchSelectedId}
          manifest={masterManifest}
          onClick={() => setSelected(it.id)}
        />
      ))}
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
  const { t } = useTranslation();
  const scopeLabel = item.scope === "global" ? t("inventoryList.scopeGlobal") : t("inventoryList.scopeProject");
  const projectLabel =
    item.scope === "project" && item.projectPath ? ` · ${basename(item.projectPath)}` : "";
  const state = manifest && !item.masterOnly ? masterStateFor(manifest, item) : null;
  const toolLabel =
    item.tool === MASTER_TOOL_SENTINEL ? t("inventoryList.masterToolLabel") : displayNameOf(item.tool);
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
          <span className="badge master-in-sync" title={t("inventoryList.masterOnlyTitle")}>
            {t("inventoryList.masterOnlyBadge")}
          </span>
        )}
        {state?.kind === "in-sync" && (
          <span className="badge master-in-sync" title={t("inventoryList.inSyncTitle")}>
            {t("inventoryList.inSyncBadge")}
          </span>
        )}
        {state?.kind === "drifted" && (
          <span className="badge master-drift" title={t("inventoryList.driftTitle")}>
            {t("inventoryList.driftBadge")}
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

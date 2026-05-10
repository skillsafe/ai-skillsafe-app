// Settings list — middle pane when type === "settings".
//
// Master-saveable files (CLAUDE.md, settings.json, .mcp.json, hooks,
// permissions, keybindings) detected by the inventory scanner, plus any
// master-only entries with no live source. Rendered in the standard
// list-pane shell to mirror the Skills/Agents/Commands experience.

import { useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { displayNameOf } from "../lib/agents/registry";
import { masterStateFor } from "../lib/master/store";
import type { Manifest } from "../lib/master/types";
import type { InventoryItem } from "../lib/inventory/types";

export const MASTER_TOOL_SENTINEL = "__master__";

export function InventoryList() {
  const tool = useApp((s) => s.tool);
  const scope = useApp((s) => s.scope);
  const projectFilter = useApp((s) => s.projectFilter);
  const workbenchSelectedId = useApp((s) => s.workbenchSelectedId);
  const inventory = useApp((s) => s.workbenchInventory);
  const loading = useApp((s) => s.workbenchLoading);
  const error = useApp((s) => s.workbenchError);
  const masterManifest = useApp((s) => s.masterManifest);
  const masterItems = useApp((s) => s.masterItems);
  const setSelected = useApp((s) => s.setWorkbenchSelectedId);
  const bumpWorkbenchScan = useApp((s) => s.bumpWorkbenchScan);
  const [query, setQuery] = useState("");

  // Live items + master-only items with no matching live source,
  // de-duplicated by id (live wins). Then narrowed by the same Tool +
  // Scope + Project selectors that drive the artifact list, so the
  // Settings filter behaves like Skills/Agents/Commands. Master-only
  // orphans (tool === MASTER_TOOL_SENTINEL) are tool-agnostic and
  // always pass the tool filter.
  const filtered = useMemo(() => {
    const live = inventory?.items ?? [];
    const liveIds = new Set(live.map((it) => it.id));
    const masterOnly = masterItems.filter((it) => !liveIds.has(it.id));
    const merged = [...live, ...masterOnly];
    const q = query.toLowerCase().trim();
    return merged.filter((it) => {
      if (it.tool !== MASTER_TOOL_SENTINEL && it.tool !== tool) return false;
      if (scope === "global" && it.scope !== "global") return false;
      if (scope === "project") {
        if (it.scope !== "project") return false;
        if (projectFilter && it.projectPath !== projectFilter) return false;
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
  }, [inventory, masterItems, tool, scope, projectFilter, query]);

  return (
    <section className="list-pane">
      <div className="list-toolbar">
        <input
          className="search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          onClick={() => bumpWorkbenchScan()}
          aria-label="Rescan inventory"
          title="Rescan tool surfaces and master folder"
          data-testid="inventory-list-refresh"
        >
          ↻
        </button>
      </div>
      {error && <div className="empty empty-error">Scan failed: {error}</div>}

      {!loading && inventory && filtered.length === 0 && (
        <div className="empty">
          {(inventory?.items.length ?? 0) === 0 && masterItems.length === 0
            ? "Nothing on disk yet for the supported tools (Claude Code, Codex, Cursor, Cline). Try installing one and re-scanning."
            : "No matches."}
        </div>
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

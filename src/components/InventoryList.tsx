// Settings list — middle pane when type === "settings".
//
// Master-saveable files (CLAUDE.md, settings.json, .mcp.json, hooks,
// permissions, keybindings) detected by the inventory scanner, plus any
// master-only entries with no live source. Rendered in the standard
// list-pane shell to mirror the Skills/Agents/Commands experience.

import { useMemo } from "react";
import { useApp } from "../lib/store";
import { displayNameOf } from "../lib/agents/registry";
import { masterStateFor } from "../lib/master/store";
import type { Manifest } from "../lib/master/types";
import type { InventoryItem } from "../lib/inventory/types";

export const MASTER_TOOL_SENTINEL = "__master__";

export function InventoryList() {
  const workbenchSelectedId = useApp((s) => s.workbenchSelectedId);
  const inventory = useApp((s) => s.workbenchInventory);
  const loading = useApp((s) => s.workbenchLoading);
  const error = useApp((s) => s.workbenchError);
  const masterManifest = useApp((s) => s.masterManifest);
  const masterItems = useApp((s) => s.masterItems);
  const setSelected = useApp((s) => s.setWorkbenchSelectedId);

  // Live items across all tools + master-only items with no matching
  // live source. De-duplicated by id; live wins so its drift state and
  // origin path are preserved.
  const filtered = useMemo(() => {
    const live = inventory?.items ?? [];
    const liveIds = new Set(live.map((it) => it.id));
    const masterOnly = masterItems.filter((it) => !liveIds.has(it.id));
    return [...live, ...masterOnly];
  }, [inventory, masterItems]);

  return (
    <section className="list-pane">
      {error && <div className="empty empty-error">Scan failed: {error}</div>}

      {!loading && inventory && filtered.length === 0 && (
        <div className="empty">
          Nothing on disk yet for the supported tools (Claude Code, Codex, Cursor, Cline). Try installing one and re-scanning.
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

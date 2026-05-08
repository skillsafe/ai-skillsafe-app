import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { loadMcp, mcpPath, saveMcp, type McpDoc } from "../lib/configs/mcp";
import {
  rowsToServers,
  serverToRow,
  type McpRow,
  type McpTransport,
} from "../lib/configs/mcpRows";

type Transport = McpTransport;
type Row = McpRow;

interface Props {
  onToast?: (kind: "ok" | "error", text: string) => void;
}

export function McpEditor({ onToast }: Props) {
  const scope = useApp((s) => s.scope);
  const projectRoot = useApp((s) => s.projectRoot);
  const projectFilter = useApp((s) => s.projectFilter);
  const recentProjects = useApp((s) => s.recentProjects);
  const setEditDirty = useApp((s) => s.setEditDirty);

  const effectiveScope = scope === "global" || scope === "all" ? "global" : "project";
  const activeProjectRoot =
    effectiveScope === "project"
      ? projectFilter ?? projectRoot ?? recentProjects[0] ?? null
      : null;

  const [doc, setDoc] = useState<McpDoc | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    if (!doc) return false;
    return JSON.stringify(rowsToServers(rows)) !==
      JSON.stringify(doc.servers.map((s) => ({ name: s.name, server: s.server })));
  }, [doc, rows]);

  useEffect(() => {
    setEditDirty(dirty);
    return () => setEditDirty(false);
  }, [dirty, setEditDirty]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const path = await mcpPath(tauriJoiner, tauriPaths, effectiveScope, activeProjectRoot);
      if (!path) {
        setDoc(null);
        setRows([]);
        return;
      }
      const next = await loadMcp(tauriFs, path);
      setDoc(next);
      setRows(next.servers.map(serverToRow));
    } catch (e) {
      setError(`Load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [effectiveScope, activeProjectRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const onAdd = (transport: Transport) => {
    setRows((rs) => [
      ...rs,
      transport === "stdio"
        ? { name: "", transport, command: "", args: "", env: "" }
        : { name: "", transport, url: "", headers: "" },
    ]);
  };

  const onUpdate = (idx: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const onRemove = (idx: number) => {
    setRows((rs) => rs.filter((_, i) => i !== idx));
  };

  const onSave = async () => {
    if (!doc || saving) return;
    setSaving(true);
    setError(null);
    try {
      const servers = rowsToServers(rows);
      // Validate before write — duplicate names would silently overwrite each
      // other once we go through the object form.
      const seen = new Set<string>();
      for (const s of servers) {
        if (seen.has(s.name)) {
          throw new Error(`Duplicate server name: ${s.name}`);
        }
        seen.add(s.name);
      }
      const saved = await saveMcp(tauriFs, doc, servers);
      setDoc(saved);
      setRows(saved.servers.map(serverToRow));
      onToast?.("ok", `Saved ${shortPath(saved.path)}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Save failed: ${msg}`);
      onToast?.("error", `Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const onRevert = () => {
    if (!doc) return;
    setRows(doc.servers.map(serverToRow));
  };

  if (effectiveScope === "project" && !activeProjectRoot) {
    return (
      <section className="editor-pane">
        <div className="empty">Pick a project in the sidebar to edit project-scope MCP servers.</div>
      </section>
    );
  }

  const filename = effectiveScope === "global"
    ? "~/.claude/.mcp.json"
    : "<project>/.mcp.json";

  return (
    <section className="editor-pane configs-editor">
      <div className="editor-toolbar">
        <div className="editor-title">
          MCP servers <span className="editor-subtitle">— {filename}</span>
        </div>
        <div className="editor-toolbar__actions">
          <button
            className="editor-toolbar__btn--primary"
            onClick={onSave}
            disabled={!dirty || saving || !doc}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={onRevert} disabled={!dirty || saving}>Revert</button>
          <button onClick={() => void load()} disabled={loading}>Reload</button>
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}
      <div className="configs-body">
        {loading && <div className="empty">Loading…</div>}
        {!loading && doc && (
          <>
            {rows.length === 0 && (
              <div className="empty">No MCP servers configured.</div>
            )}
            {rows.map((row, idx) => (
              <McpServerCard
                key={idx}
                row={row}
                onChange={(patch) => onUpdate(idx, patch)}
                onRemove={() => onRemove(idx)}
              />
            ))}
            <div className="hooks-add">
              <span>Add server:</span>
              <button type="button" className="pill" onClick={() => onAdd("stdio")}>+ stdio</button>
              <button type="button" className="pill" onClick={() => onAdd("url")}>+ url</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function McpServerCard({
  row,
  onChange,
  onRemove,
}: {
  row: Row;
  onChange: (patch: Partial<Row>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mcp-card">
      <div className="mcp-card-header">
        <input
          type="text"
          className="mcp-name"
          value={row.name}
          placeholder="server-name"
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label="Server name"
        />
        <span className="mcp-transport">{row.transport}</span>
        <button type="button" className="link-btn" onClick={onRemove} aria-label="Remove server">×</button>
      </div>
      {row.transport === "stdio" ? (
        <div className="mcp-card-body">
          <label>
            Command
            <input
              type="text"
              value={row.command ?? ""}
              placeholder="npx"
              onChange={(e) => onChange({ command: e.target.value })}
            />
          </label>
          <label>
            Args (space-separated)
            <input
              type="text"
              value={row.args ?? ""}
              placeholder="-y @modelcontextprotocol/server-foo"
              onChange={(e) => onChange({ args: e.target.value })}
            />
          </label>
          <label>
            Env (one KEY=value per line)
            <textarea
              rows={2}
              value={row.env ?? ""}
              onChange={(e) => onChange({ env: e.target.value })}
            />
          </label>
        </div>
      ) : (
        <div className="mcp-card-body">
          <label>
            URL
            <input
              type="text"
              value={row.url ?? ""}
              placeholder="https://api.example.com/mcp"
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </label>
          <label>
            Headers (one Name: value per line)
            <textarea
              rows={2}
              value={row.headers ?? ""}
              onChange={(e) => onChange({ headers: e.target.value })}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join("/");
}

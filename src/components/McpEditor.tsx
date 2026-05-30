import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { loadMcp, mcpPath, saveMcp, type McpDoc } from "../lib/configs/mcp";
import {
  rowsToServers,
  serverToRow,
  type McpRow,
  type McpTransport,
} from "../lib/configs/mcpRows";
import { lintMcp, topSeverity, type LintContext, type McpFinding } from "../lib/configs/mcpLint";
import { getTauriFeedClient } from "../lib/feeds/tauri";
import { type as osType } from "@tauri-apps/plugin-os";
import type { McpBlocklistPayload } from "../lib/feeds/types";
import { SafetyBadge } from "./SafetyBadge";

type Transport = McpTransport;
type Row = McpRow;

interface Props {
  onToast?: (kind: "ok" | "error", text: string) => void;
}

export function McpEditor({ onToast }: Props) {
  const { t } = useTranslation();
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
  const [blocklist, setBlocklist] = useState<McpBlocklistPayload | null>(null);
  const [lintCtx, setLintCtx] = useState<LintContext>({});

  useEffect(() => {
    // Fetch the blocklist lazily; lint runs against null until it arrives,
    // which is fine — heuristic checks still fire without the feed.
    void getTauriFeedClient()
      .load("mcp-blocklist")
      .then(setBlocklist)
      .catch(() => undefined);
    // Capture the host platform once so the macOS-sandbox heuristic fires
    // accurately. Skip if the OS probe rejects (web preview / mock).
    let cancelled = false;
    (async () => {
      try {
        const kind = await osType();
        if (cancelled) return;
        const platform =
          kind === "macos" ? "darwin" : kind === "linux" ? "linux" : kind === "windows" ? "windows" : null;
        setLintCtx({ platform });
      } catch {
        // Browser preview / tests do not have the Tauri OS plugin.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const findings = useMemo<McpFinding[]>(() => {
    try {
      return lintMcp(rowsToServers(rows), blocklist, lintCtx);
    } catch {
      // rowsToServers throws on malformed transport-specific fields (e.g.
      // empty URL on url transport); a typing-in-progress row shouldn't
      // crash the lint pass.
      return [];
    }
  }, [rows, blocklist, lintCtx]);

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
      setError(t("configs.loadFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(false);
    }
  }, [effectiveScope, activeProjectRoot, t]);

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
          throw new Error(t("mcp.duplicateName", { name: s.name }));
        }
        seen.add(s.name);
      }
      const saved = await saveMcp(tauriFs, doc, servers);
      setDoc(saved);
      setRows(saved.servers.map(serverToRow));
      onToast?.("ok", t("configs.savedToast", { path: shortPath(saved.path) }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(t("configs.saveFailed", { message: msg }));
      onToast?.("error", t("configs.saveFailed", { message: msg }));
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
        <div className="empty">{t("mcp.pickProjectFirst")}</div>
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
          {t("mcp.title")} <span className="editor-subtitle">— {filename}</span>
        </div>
        <div className="editor-toolbar__actions">
          <button
            className="editor-toolbar__btn--primary"
            onClick={onSave}
            disabled={!dirty || saving || !doc}
          >
            {saving ? t("configs.saving") : t("configs.save")}
          </button>
          <button onClick={onRevert} disabled={!dirty || saving}>{t("configs.revert")}</button>
          <button onClick={() => void load()} disabled={loading}>{t("configs.reload")}</button>
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}
      <div className="configs-body">
        {loading && <div className="empty">{t("configs.loading")}</div>}
        {!loading && doc && (
          <>
            {rows.length === 0 && (
              <div className="empty">{t("mcp.empty")}</div>
            )}
            {rows.map((row, idx) => (
              <McpServerCard
                key={idx}
                row={row}
                topFinding={topSeverity(findings, row.name)}
                onChange={(patch) => onUpdate(idx, patch)}
                onRemove={() => onRemove(idx)}
                t={t}
              />
            ))}
            <div className="hooks-add">
              <span>{t("mcp.addServer")}</span>
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
  topFinding,
  onChange,
  onRemove,
  t,
}: {
  row: Row;
  topFinding: McpFinding | null;
  onChange: (patch: Partial<Row>) => void;
  onRemove: () => void;
  t: TFunction;
}) {
  return (
    <div className="mcp-card">
      <div className="mcp-card-header">
        <input
          type="text"
          className="mcp-name"
          value={row.name}
          placeholder={t("mcp.namePlaceholder")}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label={t("mcp.nameAria")}
        />
        <span className="mcp-transport">{row.transport}</span>
        {topFinding && (
          <SafetyBadge
            variant={topFinding.severity}
            label={topFinding.rule_id}
            title={topFinding.message}
          />
        )}
        <button type="button" className="link-btn" onClick={onRemove} aria-label={t("mcp.removeServerAria")}>×</button>
      </div>
      {row.transport === "stdio" ? (
        <div className="mcp-card-body">
          <label>
            {t("mcp.command")}
            <input
              type="text"
              value={row.command ?? ""}
              placeholder={t("mcp.commandPlaceholder")}
              onChange={(e) => onChange({ command: e.target.value })}
            />
          </label>
          <label>
            {t("mcp.args")}
            <input
              type="text"
              value={row.args ?? ""}
              placeholder={t("mcp.argsPlaceholder")}
              onChange={(e) => onChange({ args: e.target.value })}
            />
          </label>
          <label>
            {t("mcp.env")}
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
            {t("mcp.url")}
            <input
              type="text"
              value={row.url ?? ""}
              placeholder={t("mcp.urlPlaceholder")}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </label>
          <label>
            {t("mcp.headers")}
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

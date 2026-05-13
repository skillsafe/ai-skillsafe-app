import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import {
  loadSettings,
  saveSettings,
  settingsPath,
  type SettingsDoc,
} from "../lib/configs/settingsJson";
import {
  HOOK_EVENTS,
  type HookEvent,
} from "../lib/configs/schemas";
import {
  coalesceHooks,
  flattenHooks,
  type HookRow,
} from "../lib/configs/hooksRows";

type Row = HookRow;

interface Props {
  onToast?: (kind: "ok" | "error", text: string) => void;
}

export function HooksEditor({ onToast }: Props) {
  const { t } = useTranslation();
  const scope = useApp((s) => s.scope);
  const projectRoot = useApp((s) => s.projectRoot);
  const projectFilter = useApp((s) => s.projectFilter);
  const recentProjects = useApp((s) => s.recentProjects);
  const tier = useApp((s) => s.projectSettingsTier);
  const setTier = useApp((s) => s.setProjectSettingsTier);
  const setEditDirty = useApp((s) => s.setEditDirty);

  const effectiveScope = scope === "global" || scope === "all" ? "global" : "project";
  const activeProjectRoot =
    effectiveScope === "project"
      ? projectFilter ?? projectRoot ?? recentProjects[0] ?? null
      : null;

  const [doc, setDoc] = useState<SettingsDoc | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    if (!doc) return false;
    return JSON.stringify(coalesceHooks(rows)) !== JSON.stringify(doc.hooks ?? {});
  }, [doc, rows]);

  useEffect(() => {
    setEditDirty(dirty);
    return () => setEditDirty(false);
  }, [dirty, setEditDirty]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const path = await settingsPath(
        tauriJoiner,
        tauriPaths,
        effectiveScope,
        activeProjectRoot,
        tier,
      );
      if (!path) {
        setDoc(null);
        setRows([]);
        return;
      }
      const next = await loadSettings(tauriFs, path);
      setDoc(next);
      setRows(flattenHooks(next.hooks));
    } catch (e) {
      setError(t("configs.loadFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(false);
    }
  }, [effectiveScope, activeProjectRoot, tier, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onAdd = (event: HookEvent) => {
    setRows((rs) => [...rs, { event, matcher: "", command: "" }]);
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
      // Don't write rows that are still half-typed.
      const valid = rows.filter((r) => r.command.trim().length > 0);
      const saved = await saveSettings(tauriFs, tauriJoiner, doc, {
        hooks: coalesceHooks(valid),
      });
      setDoc(saved);
      setRows(flattenHooks(saved.hooks));
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
    setRows(flattenHooks(doc.hooks));
  };

  if (effectiveScope === "project" && !activeProjectRoot) {
    return (
      <section className="editor-pane">
        <div className="empty">{t("hooks.pickProjectFirst")}</div>
      </section>
    );
  }

  const filename = effectiveScope === "global"
    ? "~/.claude/settings.json"
    : tier === "shared"
      ? "<project>/.claude/settings.json"
      : "<project>/.claude/settings.local.json";

  return (
    <section className="editor-pane configs-editor">
      <div className="editor-toolbar">
        <div className="editor-title">
          {t("hooks.title")} <span className="editor-subtitle">— {filename}</span>
        </div>
        <div className="editor-toolbar__actions">
          {effectiveScope === "project" && (
            <div className="pill-row" role="tablist" aria-label={t("configs.settingsTier")}>
              <button
                type="button"
                role="tab"
                className={`pill ${tier === "local" ? "active" : ""}`}
                aria-selected={tier === "local"}
                onClick={() => setTier("local")}
              >
                {t("configs.local")}
              </button>
              <button
                type="button"
                role="tab"
                className={`pill ${tier === "shared" ? "active" : ""}`}
                aria-selected={tier === "shared"}
                onClick={() => setTier("shared")}
              >
                {t("configs.shared")}
              </button>
            </div>
          )}
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
            <table className="hooks-table">
              <thead>
                <tr>
                  <th>{t("hooks.eventCol")}</th>
                  <th>{t("hooks.matcherCol")}</th>
                  <th>{t("hooks.commandCol")}</th>
                  <th>{t("hooks.timeoutCol")}</th>
                  <th aria-label={t("hooks.actionsAria")} />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="hooks-empty">
                      {t("hooks.empty")}
                    </td>
                  </tr>
                )}
                {rows.map((r, idx) => (
                  <tr key={idx}>
                    <td>
                      <select
                        value={r.event}
                        onChange={(e) => onUpdate(idx, { event: e.target.value as HookEvent })}
                      >
                        {HOOK_EVENTS.map((ev) => (
                          <option key={ev} value={ev}>{ev}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={r.matcher}
                        placeholder={t("hooks.matcherPlaceholder")}
                        onChange={(e) => onUpdate(idx, { matcher: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={r.command}
                        placeholder={t("hooks.commandPlaceholder")}
                        onChange={(e) => onUpdate(idx, { command: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        value={r.timeout ?? ""}
                        placeholder="—"
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          onUpdate(idx, { timeout: Number.isFinite(n) && n > 0 ? n : undefined });
                        }}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link-btn"
                        aria-label={t("hooks.removeHookAria")}
                        onClick={() => onRemove(idx)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hooks-add">
              <span>{t("hooks.addHookFor")}</span>
              {HOOK_EVENTS.map((ev) => (
                <button
                  key={ev}
                  type="button"
                  className="pill"
                  onClick={() => onAdd(ev)}
                >
                  + {ev}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function shortPath(p: string): string {
  return p.replace(/^.*\/(\.claude\/[^/]+)$/, "$1");
}

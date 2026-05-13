import Monaco from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import {
  keybindingsPath,
  loadKeybindings,
  saveKeybindings,
  saveKeybindingsRaw,
  type KeybindingsDoc,
} from "../lib/configs/keybindings";
import type { Keybinding } from "../lib/configs/schemas";

type Tab = "form" | "raw";

interface Props {
  onToast?: (kind: "ok" | "error", text: string) => void;
}

export function KeybindingsEditor({ onToast }: Props) {
  const { t } = useTranslation();
  const theme = useApp((s) => s.resolvedTheme);
  const setEditDirty = useApp((s) => s.setEditDirty);

  const [tab, setTab] = useState<Tab>("form");
  const [doc, setDoc] = useState<KeybindingsDoc | null>(null);
  const [bindings, setBindings] = useState<Keybinding[]>([]);
  const [rawDraft, setRawDraft] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formDirty = useMemo(() => {
    if (!doc) return false;
    return JSON.stringify(bindings) !== JSON.stringify(doc.bindings);
  }, [doc, bindings]);
  const rawDirty = useMemo(() => {
    if (!doc) return false;
    return rawDraft !== doc.rawText;
  }, [doc, rawDraft]);
  const dirty = tab === "form" ? formDirty : rawDirty;

  useEffect(() => {
    setEditDirty(dirty);
    return () => setEditDirty(false);
  }, [dirty, setEditDirty]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const path = await keybindingsPath(tauriJoiner, tauriPaths);
      const next = await loadKeybindings(tauriFs, path);
      setDoc(next);
      setBindings([...next.bindings]);
      setRawDraft(next.rawText);
    } catch (e) {
      setError(t("configs.loadFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onAdd = () => {
    setBindings((bs) => [...bs, { action: "", keys: "" }]);
  };

  const onUpdate = (idx: number, patch: Partial<Keybinding>) => {
    setBindings((bs) => bs.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  };

  const onRemove = (idx: number) => {
    setBindings((bs) => bs.filter((_, i) => i !== idx));
  };

  const onSave = async () => {
    if (!doc || saving) return;
    setSaving(true);
    setError(null);
    try {
      let saved: KeybindingsDoc;
      if (tab === "raw") {
        saved = await saveKeybindingsRaw(tauriFs, doc.path, rawDraft);
      } else {
        const valid = bindings.filter((b) => b.action.trim() && b.keys.trim());
        saved = await saveKeybindings(tauriFs, doc, valid);
      }
      setDoc(saved);
      setBindings([...saved.bindings]);
      setRawDraft(saved.rawText);
      onToast?.("ok", t("keybindings.savedToast"));
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
    setBindings([...doc.bindings]);
    setRawDraft(doc.rawText);
  };

  return (
    <section className="editor-pane configs-editor">
      <div className="editor-toolbar">
        <div className="editor-title">
          {t("keybindings.title")} <span className="editor-subtitle">— ~/.claude/keybindings.json</span>
        </div>
        <div className="editor-toolbar__actions">
          <div className="pill-row" role="tablist" aria-label={t("keybindings.editorTabAria")}>
            <button
              type="button"
              role="tab"
              className={`pill ${tab === "form" ? "active" : ""}`}
              aria-selected={tab === "form"}
              onClick={() => setTab("form")}
            >
              {t("keybindings.form")}
            </button>
            <button
              type="button"
              role="tab"
              className={`pill ${tab === "raw" ? "active" : ""}`}
              aria-selected={tab === "raw"}
              onClick={() => setTab("raw")}
            >
              {t("keybindings.rawJson")}
            </button>
          </div>
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
      {tab === "form" ? (
        <div className="configs-body">
          {loading && <div className="empty">{t("configs.loading")}</div>}
          {!loading && doc && (
            <>
              <table className="hooks-table">
                <thead>
                  <tr>
                    <th>{t("keybindings.actionCol")}</th>
                    <th>{t("keybindings.keysCol")}</th>
                    <th>{t("keybindings.whenCol")}</th>
                    <th aria-label={t("hooks.actionsAria")} />
                  </tr>
                </thead>
                <tbody>
                  {bindings.length === 0 && (
                    <tr><td colSpan={4} className="hooks-empty">{t("keybindings.empty")}</td></tr>
                  )}
                  {bindings.map((b, idx) => (
                    <tr key={idx}>
                      <td>
                        <input
                          type="text"
                          value={b.action}
                          placeholder={t("keybindings.actionPlaceholder")}
                          onChange={(e) => onUpdate(idx, { action: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={b.keys}
                          placeholder={t("keybindings.keysPlaceholder")}
                          onChange={(e) => onUpdate(idx, { keys: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={b.when ?? ""}
                          placeholder={t("keybindings.whenPlaceholder")}
                          onChange={(e) => {
                            const v = e.target.value;
                            onUpdate(idx, { when: v || undefined });
                          }}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link-btn"
                          aria-label={t("keybindings.removeBindingAria")}
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
                <button type="button" className="pill" onClick={onAdd}>{t("keybindings.addBinding")}</button>
                {!doc.exists && (
                  <span>{t("keybindings.willCreateOnSave")}</span>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="body-only">
          <Monaco
            height="100%"
            language="json"
            theme={theme === "light" ? "vs" : "vs-dark"}
            value={rawDraft}
            onChange={(v) => setRawDraft(v ?? "")}
            options={{
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 13,
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        </div>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import {
  loadSettings,
  saveSettings,
  settingsPath,
  type SettingsDoc,
} from "../lib/configs/settingsJson";
import {
  scanTranscriptsForRules,
  type SuggestedRule,
} from "../lib/configs/transcriptScan";
import type { Permissions } from "../lib/configs/schemas";

type Bucket = "allow" | "deny" | "ask";
const BUCKETS: { id: Bucket; label: string }[] = [
  { id: "allow", label: "Allow" },
  { id: "deny", label: "Deny" },
  { id: "ask", label: "Ask" },
];

interface Props {
  onToast?: (kind: "ok" | "error", text: string) => void;
}

export function PermissionsEditor({ onToast }: Props) {
  const scope = useApp((s) => s.scope);
  const projectRoot = useApp((s) => s.projectRoot);
  const projectFilter = useApp((s) => s.projectFilter);
  const recentProjects = useApp((s) => s.recentProjects);
  const tier = useApp((s) => s.projectSettingsTier);
  const setTier = useApp((s) => s.setProjectSettingsTier);
  const setEditDirty = useApp((s) => s.setEditDirty);

  // "all" scope is a UI sentinel for the artifacts view; configs always pick
  // a single concrete file. Treat "all" as global so the user sees something
  // meaningful instead of an empty pane.
  const effectiveScope = scope === "global" || scope === "all" ? "global" : "project";
  // When the user has selected a project filter, prefer that root; otherwise
  // fall back to the active projectRoot or the most-recent project.
  const activeProjectRoot =
    effectiveScope === "project"
      ? projectFilter ?? projectRoot ?? recentProjects[0] ?? null
      : null;

  const [doc, setDoc] = useState<SettingsDoc | null>(null);
  const [draft, setDraft] = useState<Permissions>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestedRule[] | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);

  const dirty = useMemo(() => {
    if (!doc) return false;
    return JSON.stringify(normalize(doc.permissions)) !== JSON.stringify(normalize(draft));
  }, [doc, draft]);

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
        setDraft({});
        return;
      }
      const next = await loadSettings(tauriFs, path);
      setDoc(next);
      setDraft(clone(next.permissions));
    } catch (e) {
      setError(`Load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [effectiveScope, activeProjectRoot, tier]);

  useEffect(() => {
    void load();
  }, [load]);

  const onAdd = (bucket: Bucket, value: string) => {
    const v = value.trim();
    if (!v) return;
    setDraft((d) => {
      const list = d[bucket] ?? [];
      if (list.includes(v)) return d;
      return { ...d, [bucket]: [...list, v] };
    });
  };

  const onRemove = (bucket: Bucket, idx: number) => {
    setDraft((d) => {
      const list = d[bucket] ?? [];
      const next = [...list.slice(0, idx), ...list.slice(idx + 1)];
      const out: Permissions = { ...d };
      if (next.length === 0) delete out[bucket];
      else out[bucket] = next;
      return out;
    });
  };

  const onSave = async () => {
    if (!doc || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSettings(tauriFs, tauriJoiner, doc, { permissions: draft });
      setDoc(saved);
      setDraft(clone(saved.permissions));
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
    setDraft(clone(doc.permissions));
  };

  const loadSuggestions = useCallback(async () => {
    setSuggestLoading(true);
    try {
      const rules = await scanTranscriptsForRules(tauriFs, tauriJoiner, tauriPaths);
      setSuggestions(rules);
    } catch {
      setSuggestions([]);
    } finally {
      setSuggestLoading(false);
    }
  }, []);

  const onToggleSuggest = () => {
    const next = !suggestOpen;
    setSuggestOpen(next);
    if (next && suggestions === null) void loadSuggestions();
  };

  if (effectiveScope === "project" && !activeProjectRoot) {
    return (
      <section className="editor-pane">
        <div className="empty">Pick a project in the sidebar to edit project-scope permissions.</div>
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
          Permissions <span className="editor-subtitle">— {filename}</span>
        </div>
        <div className="editor-toolbar__actions">
          {effectiveScope === "project" && (
            <div className="pill-row" role="tablist" aria-label="Settings tier">
              <button
                type="button"
                role="tab"
                className={`pill ${tier === "local" ? "active" : ""}`}
                aria-selected={tier === "local"}
                onClick={() => setTier("local")}
                title="settings.local.json — gitignored, your personal overrides"
              >
                Local
              </button>
              <button
                type="button"
                role="tab"
                className={`pill ${tier === "shared" ? "active" : ""}`}
                aria-selected={tier === "shared"}
                onClick={() => setTier("shared")}
                title="settings.json — checked into the repo, shared with the team"
              >
                Shared
              </button>
            </div>
          )}
          <button
            className="editor-toolbar__btn--primary"
            onClick={onSave}
            disabled={!dirty || saving || !doc}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={onRevert} disabled={!dirty || saving}>
            Revert
          </button>
          <button onClick={() => void load()} disabled={loading}>
            Reload
          </button>
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}
      <div className="configs-body">
        {loading && <div className="empty">Loading…</div>}
        {!loading && doc && (
          <div className="permissions-grid">
            {BUCKETS.map((b) => (
              <BucketColumn
                key={b.id}
                label={b.label}
                items={draft[b.id] ?? []}
                onAdd={(v) => onAdd(b.id, v)}
                onRemove={(i) => onRemove(b.id, i)}
              />
            ))}
          </div>
        )}
        {!loading && doc && (
          <div className="permissions-default-mode">
            <label>
              Default mode:{" "}
              <select
                value={draft.defaultMode ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft((d) => {
                    const out = { ...d };
                    if (!v) delete out.defaultMode;
                    else out.defaultMode = v as Permissions["defaultMode"];
                    return out;
                  });
                }}
              >
                <option value="">(unset)</option>
                <option value="auto">auto</option>
                <option value="ask">ask</option>
                <option value="deny">deny</option>
                <option value="allow">allow</option>
              </select>
            </label>
          </div>
        )}
        <SuggestionPanel
          open={suggestOpen}
          loading={suggestLoading}
          suggestions={suggestions ?? []}
          existing={new Set([...(draft.allow ?? []), ...(draft.deny ?? []), ...(draft.ask ?? [])])}
          onToggle={onToggleSuggest}
          onApply={(rule) => onAdd("allow", rule)}
          onReload={() => void loadSuggestions()}
        />
      </div>
    </section>
  );
}

function BucketColumn({
  label,
  items,
  onAdd,
  onRemove,
}: {
  label: string;
  items: string[];
  onAdd: (v: string) => void;
  onRemove: (idx: number) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="permissions-bucket">
      <h3>{label}</h3>
      <ul className="permissions-list">
        {items.length === 0 && <li className="permissions-empty">(none)</li>}
        {items.map((rule, idx) => (
          <li key={`${rule}-${idx}`} className="permissions-row">
            <code>{rule}</code>
            <button
              type="button"
              className="link-btn"
              aria-label={`Remove ${rule}`}
              onClick={() => onRemove(idx)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="permissions-add"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd(draft);
          setDraft("");
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='e.g. Bash(git status)'
          aria-label={`Add ${label} rule`}
        />
        <button type="submit" disabled={!draft.trim()}>Add</button>
      </form>
    </div>
  );
}

function SuggestionPanel({
  open,
  loading,
  suggestions,
  existing,
  onToggle,
  onApply,
  onReload,
}: {
  open: boolean;
  loading: boolean;
  suggestions: SuggestedRule[];
  existing: Set<string>;
  onToggle: () => void;
  onApply: (rule: string) => void;
  onReload: () => void;
}) {
  return (
    <div className="suggestions-panel">
      <button type="button" className="suggestions-toggle link-btn" onClick={onToggle}>
        {open ? "▾" : "▸"} Suggest from transcripts
      </button>
      {open && (
        <div className="suggestions-body">
          {loading && <div className="empty">Scanning ~/.claude/projects/…</div>}
          {!loading && suggestions.length === 0 && (
            <div className="empty">
              No Bash patterns found. <button className="link-btn" onClick={onReload}>Re-scan</button>
            </div>
          )}
          {!loading && suggestions.length > 0 && (
            <>
              <div className="suggestions-header">
                <span className="muted">{suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}</span>
                <button className="link-btn" onClick={onReload}>Re-scan</button>
              </div>
              <ul className="suggestions-list">
                {suggestions.map((s) => {
                  const dupe = existing.has(s.rule);
                  return (
                    <li key={s.rule}>
                      <code title={s.example ?? ""}>{s.rule}</code>
                      <span className="suggestion-count">×{s.count}</span>
                      <button
                        type="button"
                        className="link-btn"
                        disabled={dupe}
                        onClick={() => onApply(s.rule)}
                      >
                        {dupe ? "added" : "add to Allow"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function clone(p: Permissions): Permissions {
  return JSON.parse(JSON.stringify(p)) as Permissions;
}

function normalize(p: Permissions): Permissions {
  // Stable sort each list so dirty-tracking ignores reorderings introduced by
  // the loader vs. user input.
  const out: Permissions = {};
  for (const k of ["allow", "deny", "ask"] as const) {
    const list = p[k];
    if (list && list.length > 0) out[k] = [...list].sort();
  }
  if (p.defaultMode) out.defaultMode = p.defaultMode;
  return out;
}

function shortPath(p: string): string {
  return p.replace(/^.*\/(\.claude\/[^/]+)$/, "$1");
}

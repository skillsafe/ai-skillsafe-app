import Monaco from "@monaco-editor/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MarkdownArtifact } from "../lib/artifacts/types";
import { atomicWrite, sha256Hex } from "../lib/fs";
import { renderMarkdown } from "../lib/markdown";
import { PREVIEW_LANG, prettyForPreview } from "../lib/preview/fileClassify";
import { tauriFs } from "../lib/tauriAdapters";
import { getHistoryDeps } from "../lib/editHistory/runtime";
import { recordSnapshot } from "../lib/editHistory/store";
import { MAX_EDITABLE_BYTES } from "../lib/editHistory/types";
import { useApp } from "../lib/store";

interface Props {
  artifact: MarkdownArtifact | null;
  onReload?: () => void | Promise<void>;
}

interface EditState {
  draft: string;
  originalDisk: string; // exact disk content captured at edit-mode entry
  originalSha: string;
}

export function Editor({ artifact, onReload }: Props) {
  const { t } = useTranslation();
  const theme = useApp((s) => s.resolvedTheme);
  const viewedFile = useApp((s) => s.viewedFile);
  const setViewedFile = useApp((s) => s.setViewedFile);
  const setEditDirty = useApp((s) => s.setEditDirty);
  const openHistoryPanel = useApp((s) => s.openHistoryPanel);
  const closeHistoryPanel = useApp((s) => s.closeHistoryPanel);
  const historyPanelPath = useApp((s) => s.historyPanelPath);
  const [preview, setPreview] = useState(true);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showing = viewedFile ?? (artifact
    ? { name: artifact.name, path: artifact.path, content: artifact.raw || artifact.body, language: "markdown" }
    : { name: "", path: "", content: "", language: "markdown" });
  const isMarkdown = showing.language === "markdown";
  const isImage = showing.language === PREVIEW_LANG.image;
  const isTooLargeToPreview = showing.language === PREVIEW_LANG.tooLarge;
  const editing = editState !== null;
  const showPreview = isMarkdown && preview && !editing;
  const dirty = editState !== null && editState.draft !== editState.originalDisk;
  const contentBytes = useMemo(
    () => new TextEncoder().encode(showing.content).length,
    [showing.content],
  );
  const tooLarge = contentBytes > MAX_EDITABLE_BYTES;
  const canEdit = !!showing.path && !isImage && !isTooLargeToPreview && !tooLarge;

  const previewHtml = useMemo(
    () => (showPreview ? renderMarkdown(showing.content) : ""),
    [showPreview, showing.content],
  );
  const monacoValue = useMemo(
    () => (editing ? editState!.draft : prettyForPreview(showing.name, showing.content)),
    [editing, editState, showing.name, showing.content],
  );

  // Switching to a different file/artifact while editing discards the draft.
  // We reset rather than block here because the parent (App.tsx) can layer a
  // confirm prompt later — keeping the local state consistent matters more
  // than ergonomics on day-one.
  useEffect(() => {
    setEditState(null);
    setError(null);
  }, [showing.path]);

  useEffect(() => {
    setEditDirty(dirty);
  }, [dirty, setEditDirty]);

  useEffect(() => {
    return () => setEditDirty(false);
  }, [setEditDirty]);

  const onEnterEdit = async () => {
    if (!canEdit || editing) return;
    setError(null);
    try {
      // Re-read disk so the pre-edit snapshot is the true on-disk state, not
      // the possibly-stale value that was loaded into memory at app start.
      const disk = await tauriFs.readTextFile(showing.path);
      const sha = await sha256Hex(disk);
      const deps = await getHistoryDeps();
      await recordSnapshot(deps, showing.path, disk, "pre-edit");
      setEditState({ draft: disk, originalDisk: disk, originalSha: sha });
      setPreview(false);
    } catch (e) {
      setError(t("editor.enterEditFailed", { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const onCancel = () => {
    if (!editState) return;
    if (dirty && !window.confirm(t("editor.discardPrompt"))) return;
    setEditState(null);
    setError(null);
  };

  const onSave = async () => {
    if (!editState || saving) return;
    setSaving(true);
    setError(null);
    try {
      const currentDisk = await tauriFs.readTextFile(showing.path);
      if ((await sha256Hex(currentDisk)) !== editState.originalSha) {
        const overwrite = window.confirm(t("editor.diskChangedPrompt"));
        if (!overwrite) {
          setSaving(false);
          return;
        }
      }
      await atomicWrite(tauriFs, showing.path, editState.draft);
      const deps = await getHistoryDeps();
      await recordSnapshot(deps, showing.path, editState.draft, "save");
      // Reflect the new content in any cached `viewedFile` so the read-only
      // view we drop back into shows the saved bytes without a round-trip.
      if (viewedFile && viewedFile.path === showing.path) {
        setViewedFile({ ...viewedFile, content: editState.draft });
      }
      await onReload?.();
      setEditState(null);
    } catch (e) {
      setError(t("editor.saveFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const onToggleHistory = () => {
    if (!showing.path) return;
    if (historyPanelPath === showing.path) closeHistoryPanel();
    else openHistoryPanel(showing.path);
  };

  if (!artifact && !viewedFile) {
    return (
      <section className="editor-pane">
        <div className="empty">{t("editor.emptyHint")}</div>
      </section>
    );
  }

  return (
    <section className="editor-pane">
      <div className="editor-toolbar">
        <div className="editor-title">{showing.name}</div>
        <div className="editor-toolbar__actions">
          {!editing && isMarkdown && (
            <button onClick={() => setPreview((p) => !p)}>
              {preview ? t("editor.source") : t("editor.preview")}
            </button>
          )}
          {!editing && (
            <button
              onClick={onEnterEdit}
              disabled={!canEdit}
              title={
                isImage
                  ? t("editor.editTitleImages")
                  : tooLarge
                    ? t("editor.editTitleTooLarge")
                    : t("editor.editTitle")
              }
            >
              {t("editor.editButton")}
            </button>
          )}
          {editing && (
            <>
              <button
                className="editor-toolbar__btn--primary"
                onClick={onSave}
                disabled={saving || !dirty}
              >
                {saving ? t("editor.saving") : t("editor.saveButton")}
              </button>
              <button onClick={onCancel} disabled={saving}>
                {t("common.cancel")}
              </button>
            </>
          )}
          <button
            onClick={onToggleHistory}
            disabled={!showing.path}
            className={historyPanelPath === showing.path ? "editor-toolbar__btn--active" : ""}
          >
            {t("editor.history")}
          </button>
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}
      <div className="body-only">
        {isImage ? (
          <div className="img-preview">
            <img src={convertFileSrc(showing.path)} alt={showing.name} />
          </div>
        ) : isTooLargeToPreview ? (
          <div className="md-preview">
            <p>{t("editor.tooLargeToPreview", { size: formatBytesShort(Number(showing.content) || 0) })}</p>
            {showing.path && (
              <button onClick={() => shellOpen(showing.path)}>
                {t("editor.openExternally")}
              </button>
            )}
          </div>
        ) : showPreview ? (
          <div className="md-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        ) : (
          <Monaco
            key={showing.path}
            height="100%"
            language={showing.language}
            theme={theme === "light" ? "vs" : "vs-dark"}
            value={monacoValue}
            onChange={(v) => {
              if (!editState) return;
              setEditState({ ...editState, draft: v ?? "" });
            }}
            onMount={(editor) => requestAnimationFrame(() => editor.layout())}
            options={{
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 13,
              scrollBeyondLastLine: false,
              readOnly: !editing,
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </section>
  );
}

function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

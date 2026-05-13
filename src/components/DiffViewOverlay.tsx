import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { tauriFs } from "../lib/tauriAdapters";
import { getHistoryDeps } from "../lib/editHistory/runtime";
import { getEntry, readSnapshot } from "../lib/editHistory/store";
import { useApp } from "../lib/store";
import { DiffView } from "./DiffView";

function languageFromPath(p: string): string {
  const ext = p.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "md":
    case "markdown":
      return "markdown";
    case "json":
      return "json";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "yaml":
    case "yml":
      return "yaml";
    case "css":
      return "css";
    case "html":
      return "html";
    case "sh":
    case "bash":
      return "shell";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "toml":
      return "toml";
    default:
      return "plaintext";
  }
}

export function DiffViewOverlay() {
  const { t } = useTranslation();
  const ref = useApp((s) => s.diffEntry);
  const close = useApp((s) => s.closeDiffEntry);
  const [original, setOriginal] = useState<string | null>(null);
  const [modified, setModified] = useState<string | null>(null);
  const [label, setLabel] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!ref) {
      setOriginal(null);
      setModified(null);
      setLabel("");
      setError(null);
      return;
    }
    (async () => {
      try {
        const deps = await getHistoryDeps();
        const entry = await getEntry(deps, ref.absPath, ref.entryId);
        if (cancelled) return;
        if (!entry) throw new Error(t("diffOverlay.snapshotNotFound"));
        const blob = await readSnapshot(deps, ref.absPath, ref.entryId);
        if (cancelled) return;
        if (blob === null) throw new Error(t("diffOverlay.snapshotContentMissing"));
        let current = "";
        try {
          current = await tauriFs.readTextFile(ref.absPath);
        } catch {
          // File may have been deleted; show empty as current so the diff
          // still renders rather than throwing the user out of the overlay.
          current = "";
        }
        if (cancelled) return;
        setOriginal(blob);
        setModified(current);
        setLabel(new Date(entry.ts).toLocaleString());
      } catch (e) {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ref]);

  if (!ref) return null;

  if (error) {
    return (
      <div className="diff-overlay diff-overlay--error">
        <div className="diff-overlay__header">
          <div>{t("diffOverlay.failed", { error })}</div>
          <button className="diff-overlay__close" onClick={close}>
            {t("common.close")}
          </button>
        </div>
      </div>
    );
  }

  if (original === null || modified === null) {
    return (
      <div className="diff-overlay">
        <div className="diff-overlay__header">
          <div>{t("diffOverlay.loading")}</div>
          <button className="diff-overlay__close" onClick={close}>
            {t("common.close")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <DiffView
      original={original}
      modified={modified}
      language={languageFromPath(ref.absPath)}
      originalLabel={t("diffOverlay.snapshotLabel", { label })}
      modifiedLabel={t("diffOverlay.currentLabel")}
      onClose={close}
    />
  );
}

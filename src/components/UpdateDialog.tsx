import { useState } from "react";
import { marked } from "marked";
import { useApp } from "../lib/store";
import { CloseIcon } from "./icons";

interface Props {
  onAccept: () => Promise<void>;
  onLater: () => void;
  onSkip: () => void;
}

// Prompt-flow modal: only shown when autoUpdate === false. Renders release
// notes (markdown) and lets the user start a download → install → relaunch.
export function UpdateDialog({ onAccept, onLater, onSkip }: Props) {
  const { availableUpdate, currentVersion, updateProgress, updateError } = useApp();
  const [installing, setInstalling] = useState(false);

  if (!availableUpdate) return null;

  const notesHtml = (() => {
    try {
      return marked.parse(availableUpdate.notes || "_No release notes._", { async: false }) as string;
    } catch {
      return availableUpdate.notes || "";
    }
  })();

  const total = updateProgress?.totalBytes ?? null;
  const pct =
    updateProgress && total && total > 0
      ? Math.min(100, Math.round((updateProgress.downloadedBytes / total) * 100))
      : null;

  async function handleAccept() {
    setInstalling(true);
    try {
      await onAccept();
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={installing ? undefined : onLater}>
      <div className="dialog update-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h3>Update available</h3>
          {!installing && (
            <button className="settings-close icon-btn" aria-label="Close" onClick={onLater}>
              <CloseIcon size={14} />
            </button>
          )}
        </header>
        <div className="settings-body">
          <div className="update-version-line">
            <span className="account-namespace">v{currentVersion}</span>
            <span aria-hidden="true">→</span>
            <span className="account-namespace">v{availableUpdate.version}</span>
          </div>
          <div className="update-notes" dangerouslySetInnerHTML={{ __html: notesHtml }} />
          {installing && (
            <div className="update-installing">
              <div className="update-installing-label">
                {updateProgress?.phase === "installing"
                  ? "Installing…"
                  : updateProgress?.phase === "done"
                  ? "Restarting…"
                  : `Downloading${pct !== null ? ` — ${pct}%` : "…"}`}
              </div>
              {pct !== null && updateProgress?.phase === "downloading" && (
                <div className="update-progress">
                  <div className="update-progress-bar" style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          )}
          {updateError && !installing && (
            <div className="update-error">{updateError}</div>
          )}
        </div>
        <footer className="update-dialog-footer">
          <button onClick={onSkip} disabled={installing}>
            Skip this version
          </button>
          <button onClick={onLater} disabled={installing}>
            Later
          </button>
          <button className="primary" onClick={handleAccept} disabled={installing}>
            {installing ? "Working…" : "Update now"}
          </button>
        </footer>
      </div>
    </div>
  );
}

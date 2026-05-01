import { useApp } from "../lib/store";
import { CloseIcon, DownloadIcon } from "./icons";

interface Props {
  onRestartNow: () => void;
}

// Small banner shown above the sidebar when the auto-update flow has either
// downloaded an update (ready) or is downloading one (progress). Hidden in
// the prompt flow (those use UpdateDialog instead).
export function UpdateBanner({ onRestartNow }: Props) {
  const {
    autoUpdate,
    availableUpdate,
    updateProgress,
    updateReadyToInstall,
    setUpdateReadyToInstall,
  } = useApp();

  if (!autoUpdate) return null;

  const downloading =
    updateProgress?.phase === "downloading" || updateProgress?.phase === "installing";

  if (!downloading && !updateReadyToInstall) return null;

  if (downloading && updateProgress) {
    const total = updateProgress.totalBytes;
    const pct =
      total && total > 0
        ? Math.min(100, Math.round((updateProgress.downloadedBytes / total) * 100))
        : null;
    return (
      <div className="update-banner update-banner-downloading" role="status">
        <DownloadIcon size={14} />
        <span className="update-banner-text">
          Downloading update
          {availableUpdate ? ` v${availableUpdate.version}` : ""}
          {pct !== null ? ` — ${pct}%` : "…"}
        </span>
        {pct !== null && (
          <div className="update-progress" aria-hidden="true">
            <div className="update-progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    );
  }

  // Ready
  return (
    <div className="update-banner update-banner-ready" role="status">
      <DownloadIcon size={14} />
      <span className="update-banner-text">
        AI SkillSafe v{availableUpdate?.version ?? ""} is ready — installs on next launch.
      </span>
      <button className="update-banner-action primary" onClick={onRestartNow}>
        Restart now
      </button>
      <button
        className="update-banner-dismiss icon-btn"
        aria-label="Dismiss update banner"
        onClick={() => setUpdateReadyToInstall(false)}
        title="Hide this banner — install still happens on next quit"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

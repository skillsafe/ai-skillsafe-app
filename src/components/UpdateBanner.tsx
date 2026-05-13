import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { CloseIcon, DownloadIcon } from "./icons";

interface Props {
  onRestartNow: () => void;
}

// Floating bottom-left pill, shown only when an update has finished
// downloading and is ready to install. 1-click "Restart to update to vX" + a × that
// persists the dismiss against that specific update version (so it stays
// hidden across sessions until a newer version arrives). Download progress
// is intentionally surfaced in Settings → About instead, to keep the main
// window quiet while a background download is in flight.
export function UpdateBanner({ onRestartNow }: Props) {
  const { t } = useTranslation();
  const {
    autoUpdate,
    availableUpdate,
    updateReadyToInstall,
    dismissedUpdateVersion,
    setUpdateReadyToInstall,
    setDismissedUpdateVersion,
  } = useApp();

  if (!autoUpdate) return null;
  if (!updateReadyToInstall) return null;
  if (availableUpdate && dismissedUpdateVersion === availableUpdate.version) {
    return null;
  }

  const version = availableUpdate?.version ?? "";
  const label = t("updateBanner.restartToUpdate", { version });
  return (
    <div className="update-pill update-pill-ready" role="status">
      <button
        className="update-pill-action"
        onClick={onRestartNow}
        title={label}
      >
        <DownloadIcon size={14} />
        <span className="update-pill-text">{label}</span>
      </button>
      <button
        className="update-pill-dismiss icon-btn"
        aria-label={t("updateBanner.dismissAria")}
        onClick={() => {
          if (version) setDismissedUpdateVersion(version);
          setUpdateReadyToInstall(false);
        }}
        title={t("updateBanner.dismissTitle")}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

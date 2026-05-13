import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { AccountPanel } from "./AccountPanel";
import { GlobeIcon } from "./icons";

interface Props {
  onToast: (kind: "ok" | "error", text: string) => void;
  onReload: () => void;
  onOpenActions: () => void;
}

export function CloudInfoPane({ onToast, onReload, onOpenActions }: Props) {
  const { t } = useTranslation();
  const {
    cloudApiKey,
    cloudAccount,
    remoteFilter,
    remoteQuery,
    remoteSort,
    remoteLoading,
    setRemoteFilter,
    setRemoteQuery,
    setRemoteSort,
  } = useApp();

  return (
    <aside className="sidebar cloud-info-pane">
      <div className="brand">
        <span className="brand-globe"><GlobeIcon size={20} /></span>
        <div className="brand-title">skillsafe.ai</div>
      </div>

      {!cloudApiKey ? (
        <AccountPanel onToast={onToast} />
      ) : (
        <>
          <div className="section-label">{t("cloudInfo.account")}</div>
          <div className="cloud-account-summary">
            <div className="cloud-account-line">
              <span className="cloud-account-ns">{cloudAccount?.namespace ?? "…"}</span>
              {cloudAccount?.tier && (
                <span className="badge tier">{cloudAccount.tier}</span>
              )}
            </div>
            {cloudAccount?.email && (
              <div className="cloud-account-email">{cloudAccount.email}</div>
            )}
          </div>
        </>
      )}

      {cloudApiKey && (
        <>
          <div className="section-label" id="cloud-filter-label">{t("cloudInfo.filter")}</div>
          <div className="pill-row" role="tablist" aria-labelledby="cloud-filter-label">
            <button
              type="button"
              role="tab"
              aria-selected={remoteFilter === "all"}
              className={`pill ${remoteFilter === "all" ? "active" : ""}`}
              onClick={() => setRemoteFilter("all")}
              title={t("cloudInfo.allTitle")}
            >
              {t("cloudInfo.all")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={remoteFilter === "private"}
              className={`pill ${remoteFilter === "private" ? "active" : ""}`}
              onClick={() => setRemoteFilter("private")}
              title={t("cloudInfo.privateTitle")}
            >
              {t("cloudInfo.private")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={remoteFilter === "shared"}
              className={`pill ${remoteFilter === "shared" ? "active" : ""}`}
              onClick={() => setRemoteFilter("shared")}
              title={t("cloudInfo.sharedTitle")}
            >
              {t("cloudInfo.shared")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={remoteFilter === "public"}
              className={`pill ${remoteFilter === "public" ? "active" : ""}`}
              onClick={() => setRemoteFilter("public")}
              title={t("cloudInfo.publicTitle")}
            >
              {t("cloudInfo.public")}
            </button>
          </div>
        </>
      )}

      <div className="section-label">
        {cloudApiKey ? t("cloudInfo.search") : t("cloudInfo.searchPublic")}
      </div>
      <div className="cloud-info-search">
        <input
          placeholder={t("cloudInfo.searchPlaceholder")}
          value={remoteQuery}
          onChange={(e) => setRemoteQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onReload(); }}
        />
        <select
          value={remoteSort}
          onChange={(e) => setRemoteSort(e.target.value)}
        >
          <option value="popular">{t("cloudInfo.sortPopular")}</option>
          <option value="updated">{t("cloudInfo.sortUpdated")}</option>
          <option value="recent">{t("cloudInfo.sortRecent")}</option>
          <option value="stars">{t("cloudInfo.sortStars")}</option>
          <option value="trending">{t("cloudInfo.sortTrending")}</option>
          <option value="verified">{t("cloudInfo.sortVerified")}</option>
        </select>
      </div>

      <div className="cloud-info-actions">
        <button className="primary" onClick={onReload} disabled={remoteLoading}>
          {remoteLoading ? t("common.loading") : t("cloudInfo.searchButton")}
        </button>
        {cloudApiKey && (
          <button onClick={onOpenActions}>{t("cloudInfo.saveShare")}</button>
        )}
      </div>
    </aside>
  );
}

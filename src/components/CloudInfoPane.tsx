import { useApp } from "../lib/store";
import { AccountPanel } from "./AccountPanel";
import { GlobeIcon } from "./icons";

interface Props {
  onToast: (kind: "ok" | "error", text: string) => void;
  onReload: () => void;
  onOpenActions: () => void;
}

export function CloudInfoPane({ onToast, onReload, onOpenActions }: Props) {
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
          <div className="section-label">Account</div>
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
          <div className="section-label" id="cloud-filter-label">Filter</div>
          <div className="pill-row" role="tablist" aria-labelledby="cloud-filter-label">
            <button
              type="button"
              role="tab"
              aria-selected={remoteFilter === "all"}
              className={`pill ${remoteFilter === "all" ? "active" : ""}`}
              onClick={() => setRemoteFilter("all")}
              title="All your skills (private + shared)"
            >
              All
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={remoteFilter === "private"}
              className={`pill ${remoteFilter === "private" ? "active" : ""}`}
              onClick={() => setRemoteFilter("private")}
              title="Your skills that are not shared"
            >
              Private
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={remoteFilter === "shared"}
              className={`pill ${remoteFilter === "shared" ? "active" : ""}`}
              onClick={() => setRemoteFilter("shared")}
              title="Your skills that are public or have active share links"
            >
              Shared
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={remoteFilter === "public"}
              className={`pill ${remoteFilter === "public" ? "active" : ""}`}
              onClick={() => setRemoteFilter("public")}
              title="Browse the public catalog"
            >
              Public
            </button>
          </div>
        </>
      )}

      <div className="section-label">
        {cloudApiKey ? "Search" : "Search public skills"}
      </div>
      <div className="cloud-info-search">
        <input
          placeholder="Search skills…"
          value={remoteQuery}
          onChange={(e) => setRemoteQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onReload(); }}
        />
        <select
          value={remoteSort}
          onChange={(e) => setRemoteSort(e.target.value)}
        >
          <option value="popular">popular</option>
          <option value="updated">updated</option>
          <option value="recent">recent</option>
          <option value="stars">stars</option>
          <option value="trending">trending</option>
          <option value="verified">verified</option>
        </select>
      </div>

      <div className="cloud-info-actions">
        <button className="primary" onClick={onReload} disabled={remoteLoading}>
          {remoteLoading ? "Loading…" : "Search"}
        </button>
        {cloudApiKey && (
          <button onClick={onOpenActions}>Save / Share…</button>
        )}
      </div>
    </aside>
  );
}

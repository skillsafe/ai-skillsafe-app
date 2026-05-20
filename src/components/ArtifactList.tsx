import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type as osType } from "@tauri-apps/plugin-os";
import { useApp } from "../lib/store";
import { AttachmentTree } from "./AttachmentTree";
import { ScanReportPanel } from "./ScanReportPanel";
import { SafetyBadge } from "./SafetyBadge";
import { SecretsPanel } from "./SecretsPanel";
import { ArchiveIcon, ShieldCheckIcon, TargetIcon, TrashIcon, UploadCloudIcon } from "./icons";
import type { MarkdownArtifact } from "../lib/artifacts/types";
import { scanArtifact } from "../lib/scan/artifact";
import { tauriFs } from "../lib/tauriAdapters";
import type { LocalScanReport } from "../lib/scan/types";
import { getStatusBlock, isQuarantined, isRewritten } from "../lib/artifacts/status";
import type { RewriteOs } from "../lib/secrets/keychainTemplate";

interface Props {
  onReload: () => void;
  onDelete: (artifact: MarkdownArtifact) => void;
  onBackup: (artifact: MarkdownArtifact) => void;
  onUpload: (artifact: MarkdownArtifact) => void;
  onOpenTriggerDebugger: () => void;
}

export function ArtifactList({
  onReload,
  onDelete,
  onBackup,
  onUpload,
  onOpenTriggerDebugger,
}: Props) {
  const { t } = useTranslation();
  const {
    artifacts,
    selectedId,
    setSelectedId,
    driftByName,
    error,
    recentProjects,
    scope,
    backupDestination,
    cloudApiKey,
    localScans,
    setLocalScan,
    focusedArtifactPaths,
    setFocusedArtifactPaths,
  } = useApp();
  const [query, setQuery] = useState("");
  const [scanningAll, setScanningAll] = useState(false);
  // Host OS — used by SecretsPanel to render the right keychain command.
  // Defaults to darwin so initial render doesn't flicker.
  const [hostOs, setHostOs] = useState<RewriteOs>("darwin");
  useEffect(() => {
    void Promise.resolve(osType())
      .then((kind) => {
        if (kind === "macos") setHostOs("darwin");
        else if (kind === "windows") setHostOs("windows");
        else setHostOs("linux");
      })
      .catch(() => undefined);
  }, []);

  const runScan = useCallback(
    async (artifact: MarkdownArtifact) => {
      setLocalScan(artifact.id, "scanning");
      try {
        const report = await scanArtifact(tauriFs, artifact);
        setLocalScan(artifact.id, report);
      } catch (err) {
        console.warn("[scan] failed for", artifact.id, err);
        setLocalScan(artifact.id, null);
      }
    },
    [setLocalScan],
  );

  // Lazy-scan whenever the user opens an artifact card. The scanner is pure
  // TS and trivial for typical bundles (a few KB); we only memoize by id so
  // editing the body re-triggers via the explicit "rescan" affordance.
  useEffect(() => {
    if (!selectedId) return;
    const a = artifacts.find((x) => x.id === selectedId);
    if (!a) return;
    if (localScans[a.id] !== undefined) return;
    void runScan(a);
  }, [selectedId, artifacts, localScans, runScan]);

  const scanAll = useCallback(async () => {
    if (scanningAll) return;
    setScanningAll(true);
    try {
      for (const a of artifacts) {
        if (localScans[a.id] !== undefined && localScans[a.id] !== "scanning") continue;
        await runScan(a);
      }
    } finally {
      setScanningAll(false);
    }
  }, [scanningAll, artifacts, localScans, runScan]);

  // Map project root → display name (last folder segment) so artifact cards
  // can show which project they came from when aggregating multiple roots.
  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of recentProjects) {
      const segments = p.replace(/\/+$/, "").split(/[\\/]/);
      m.set(p, segments[segments.length - 1] || p);
    }
    return m;
  }, [recentProjects]);
  const projectRootForArtifact = (id: string): string | null => {
    // Aggregated artifacts have id `${projectRoot}::${origId}` — see App.tsx.
    const idx = id.indexOf("::");
    if (idx < 0) return null;
    return id.slice(0, idx);
  };

  const filtered = useMemo(() => {
    let pool = artifacts;
    if (focusedArtifactPaths && focusedArtifactPaths.length > 0) {
      const want = new Set(focusedArtifactPaths);
      pool = artifacts.filter((a) => want.has(a.bundleDir ?? a.path));
    }
    const q = query.toLowerCase().trim();
    if (!q) return pool;
    return pool.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        String(a.frontmatter.description ?? "")
          .toLowerCase()
          .includes(q),
    );
  }, [artifacts, query, focusedArtifactPaths]);

  return (
    <section className="list-pane">
      <div className="list-toolbar">
        <input
          className="search"
          placeholder={t("artifactList.filterPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={onReload} aria-label={t("artifactList.reloadAria")} title={t("artifactList.reloadTitle")}>
          ↻
        </button>
        <button
          className="icon-btn"
          onClick={scanAll}
          disabled={scanningAll || artifacts.length === 0}
          aria-label={t("artifactList.scanAllAria")}
          title={t("artifactList.scanAllTitle")}
        >
          <ShieldCheckIcon size={14} />
        </button>
        <button
          className="icon-btn"
          onClick={onOpenTriggerDebugger}
          aria-label={t("sidebar.triggerDebuggerAria")}
          title={t("sidebar.triggerDebuggerTitle")}
        >
          <TargetIcon size={14} />
        </button>
      </div>
      {focusedArtifactPaths && focusedArtifactPaths.length > 0 && (
        <div className="focus-bar">
          <span>{t("artifactList.focusBar", { count: focusedArtifactPaths.length })}</span>
          <button className="link-btn" onClick={() => setFocusedArtifactPaths(null)}>
            {t("artifactList.clearFocus")}
          </button>
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="empty">
          {artifacts.length === 0 ? t("artifactList.noArtifacts") : t("artifactList.noMatches")}
          {error && <div className="empty-error">{error}</div>}
        </div>
      ) : (
        filtered.map((a) => {
          const drift = driftByName[a.name] === true;
          const desc = String(a.frontmatter.description ?? "").trim();
          const isActive = selectedId === a.id;
          const canUpload = a.isBundle && !!a.bundleDir;
          const scanState = localScans[a.id];
          const badge = makeBadge(scanState, {
            scanning: String(t("scanReport.scanning")),
            scanFailed: String(t("scanReport.scanFailed")),
            noIssues: String(t("scanReport.noIssues")),
            findings: String(t("scanReport.findingsCount", { count: (scanState && scanState !== "scanning") ? scanState.findings_count : 0 })),
          });
          return (
            <div key={a.id}>
              <div
                className={`artifact-card ${isActive ? "active" : ""}`}
                onClick={() => setSelectedId(isActive ? null : a.id)}
              >
                <div className="artifact-name">
                  {a.name}
                  {drift && <span className="badge drift">{t("artifactList.driftBadge")}</span>}
                  {isQuarantined(a) && (
                    <SafetyBadge
                      variant="quarantined"
                      label={t("artifactList.quarantinedBadge")}
                      title={getStatusBlock(a)?.reason ?? t("artifactList.quarantinedBadge")}
                    />
                  )}
                  {isRewritten(a) && (
                    <SafetyBadge
                      variant="rewritten"
                      label={t("artifactList.rewrittenBadge")}
                      title={getStatusBlock(a)?.reason ?? t("artifactList.rewrittenBadge")}
                    />
                  )}
                  {badge && (
                    <span
                      className={`badge scan-badge scan-badge-${badge.tone}`}
                      title={badge.title}
                    >
                      {badge.label}
                    </span>
                  )}
                </div>
                {desc && <div className="artifact-desc">{truncate(desc, 160)}</div>}
                <div className="artifact-meta">
                  <span>{a.tool}</span>
                  {(scope === "project" || scope === "lockfile") && (() => {
                    const root = projectRootForArtifact(a.id);
                    const name = root ? projectName.get(root) : null;
                    return name ? (
                      <>
                        <span>·</span>
                        <span title={root ?? ""} className="artifact-project">{name}</span>
                      </>
                    ) : null;
                  })()}
                  {a.mtimeMs ? (
                    <>
                      <span>·</span>
                      <span>{new Date(a.mtimeMs).toLocaleString()}</span>
                    </>
                  ) : null}
                </div>
                {(a.bundleDir ?? a.path) && (
                  <div className="artifact-path" title={a.bundleDir ?? a.path}>
                    {prettifyPath(a.bundleDir ?? a.path)}
                  </div>
                )}
                <div className="card-actions">
                  <button
                    className="icon-btn"
                    aria-label={t("artifactList.backupAria", { name: a.name })}
                    title={
                      backupDestination
                        ? t("artifactList.backupTitleReady")
                        : t("artifactList.backupTitleNeedsSetup")
                    }
                    disabled={!backupDestination}
                    onClick={(e) => { e.stopPropagation(); onBackup(a); }}
                  >
                    <ArchiveIcon size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={t("artifactList.uploadAria", { name: a.name })}
                    title={
                      !canUpload
                        ? t("artifactList.uploadTitleNotBundle")
                        : !cloudApiKey
                          ? t("artifactList.uploadTitleNotSignedIn")
                          : t("artifactList.uploadTitleReady")
                    }
                    disabled={!canUpload || !cloudApiKey}
                    onClick={(e) => { e.stopPropagation(); onUpload(a); }}
                  >
                    <UploadCloudIcon size={14} />
                  </button>
                  <button
                    className="icon-btn danger"
                    aria-label={t("artifactList.deleteAria", { name: a.name })}
                    title={t("artifactList.deleteTitle")}
                    onClick={(e) => { e.stopPropagation(); onDelete(a); }}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>
              {isActive && a.isBundle && (
                <div className="card-tree">
                  <AttachmentTree
                    attachments={a.attachments}
                    bundleDir={a.bundleDir}
                    skillName={a.name}
                    skillBody={a.body}
                  />
                  <LocalScanCard
                    report={scanState}
                    onRescan={() => runScan(a)}
                  />
                  {scanState && scanState !== "scanning" && (
                    <SecretsPanel
                      artifact={a}
                      report={scanState}
                      os={hostOs}
                      onApplied={() => runScan(a)}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

function LocalScanCard({
  report,
  onRescan,
}: {
  report: LocalScanReport | "scanning" | null | undefined;
  onRescan: () => void;
}) {
  const { t } = useTranslation();
  if (report === undefined) return null;
  if (report === "scanning") {
    return (
      <div className="scan-panel scan-panel-muted">
        <div className="scan-panel-row">
          <span className="scan-icon" aria-hidden="true">…</span>
          <span className="scan-title">{t("scanReport.scanning")}</span>
        </div>
      </div>
    );
  }
  if (report === null) {
    return (
      <div className="scan-panel scan-panel-muted">
        <div className="scan-panel-row">
          <span className="scan-icon" aria-hidden="true">!</span>
          <span className="scan-title">{t("scanReport.scanFailed")}</span>
          <button className="scan-rescan" onClick={onRescan}>
            {t("scanReport.rescan")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="scan-panel-wrap">
      <ScanReportPanel report={report} />
      <button className="scan-rescan" onClick={onRescan}>
        {t("scanReport.rescan")}
      </button>
    </div>
  );
}

interface Badge {
  label: string;
  tone: "ok" | "warn" | "danger" | "muted";
  title: string;
}

interface BadgeLabels {
  scanning: string;
  scanFailed: string;
  noIssues: string;
  findings: string;
}

function makeBadge(
  state: LocalScanReport | "scanning" | null | undefined,
  labels: BadgeLabels,
): Badge | null {
  if (state === undefined) return null;
  if (state === "scanning") return { label: "…", tone: "muted", title: labels.scanning };
  if (state === null) return { label: "!", tone: "warn", title: labels.scanFailed };
  if (state.clean) return { label: "✓", tone: "ok", title: labels.noIssues };
  const risk = state.bom.risk_surface;
  const tone: Badge["tone"] = risk === "critical" || risk === "high" ? "danger" : "warn";
  return { label: String(state.findings_count), tone, title: labels.findings };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Collapse $HOME → "~" so the row stays narrow while still uniquely
// identifying which bundle on disk this card represents. We match POSIX
// home roots structurally (/Users/<u> on macOS, /home/<u> on Linux) and
// Windows user dirs (C:\Users\<u>); seeing the same prefix on every path
// would be a stronger signal but isn't worth the bookkeeping here.
export function prettifyPath(p: string): string {
  const posix = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)/.exec(p);
  if (posix) return "~" + p.slice(posix[0].length);
  const win = /^([A-Za-z]:\\Users\\[^\\]+)/.exec(p);
  if (win) return "~" + p.slice(win[0].length);
  return p;
}

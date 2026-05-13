import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useApp } from "../lib/store";
import { fetchAccount, runDeviceFlow } from "../lib/skillsafe/auth";
import { SkillSafeError } from "../lib/skillsafe/client";
import { CloseIcon, FolderIcon, MonitorIcon, MoonIcon, SunIcon, TrashIcon } from "./icons";
import { BackupPanel } from "./BackupPanel";
import { checkForUpdate, installAndRelaunch, isManualUpdate } from "../lib/update/runner";
import { NATIVE_NAME, SUPPORTED, type Locale } from "../i18n";

interface Props {
  onClose: () => void;
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function SettingsDialog({ onClose, onToast }: Props) {
  const { t } = useTranslation();
  const {
    theme,
    setTheme,
    locale,
    setLocale,
    cloudApiKey,
    cloudAccount,
    setCloudAuth,
    projectRoot,
    setProjectRoot,
    recentProjects,
    removeRecentProject,
    resetLayout,
    autoUpdate,
    setAutoUpdate,
    currentVersion,
    availableUpdate,
    updateReadyToInstall,
    updateProgress,
    setUpdateProgress,
    setUpdateError,
    setUpdateReadyToInstall,
    setAvailableUpdate,
    settingsScrollTarget,
    setSettingsScrollTarget,
  } = useApp();
  const [signingIn, setSigningIn] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!settingsScrollTarget) return;
    const id = settingsScrollTarget;
    const r = requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
      setSettingsScrollTarget(null);
    });
    return () => cancelAnimationFrame(r);
  }, [settingsScrollTarget, setSettingsScrollTarget]);

  async function handleCheckForUpdates() {
    setCheckingUpdate(true);
    try {
      const update = await checkForUpdate();
      if (!update) {
        setAvailableUpdate(null);
        onToast("ok", t("toast.alreadyLatest", { version: currentVersion }));
        return;
      }
      setAvailableUpdate({ version: update.version, notes: update.body ?? "", date: update.date });
      if (isManualUpdate(update) && update.kind === "download-page") {
        onToast("ok", t("toast.updateOpeningDownload", { version: update.version }));
        try {
          await shellOpen(update.downloadPageUrl);
        } catch (e) {
          onToast("error", t("toast.couldNotOpenDownload", { message: e instanceof Error ? e.message : String(e) }));
        }
      } else if (autoUpdate) {
        try {
          await installAndRelaunch(update, setUpdateProgress);
        } catch (e) {
          setUpdateError(e instanceof Error ? e.message : String(e));
          onToast("error", t("toast.updateFailed", { message: e instanceof Error ? e.message : String(e) }));
        }
      } else {
        onToast("ok", t("toast.updateAvailableShort", { version: update.version }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onToast("error", t("toast.updateCheckFailed", { message: msg }));
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleRestartAndInstall() {
    setRestarting(true);
    try {
      // `check()` returns a fresh Update handle each call; install() can't be
      // called before download(), so we re-check and downloadAndInstall here.
      const update = await checkForUpdate();
      if (!update) {
        onToast("ok", t("toast.updateNoLongerAvailable"));
        setUpdateReadyToInstall(false);
        return;
      }
      await installAndRelaunch(update, setUpdateProgress);
    } catch (e) {
      onToast("error", t("toast.installFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRestarting(false);
    }
  }

  async function handleSignIn() {
    setSigningIn(true);
    try {
      const apiKey = await runDeviceFlow({
        onAuthUrl: (url) => {
          shellOpen(url).then(
            () => onToast("ok", t("toast.openBrowser")),
            (e) => {
              console.error("shell.open failed:", e);
              const msg = e instanceof SkillSafeError ? `${e.code}: ${e.message}` : (e instanceof Error ? e.message : String(e));
              onToast("error", t("toast.couldNotOpenBrowser", { reason: msg, url }));
            },
          );
        },
      });
      const account = await fetchAccount(apiKey);
      setCloudAuth(apiKey, account);
      onToast("ok", t("toast.signedInAs", { namespace: account.namespace }));
    } catch (e) {
      const msg = e instanceof SkillSafeError ? `${e.code}: ${e.message}` : String(e);
      onToast("error", t("toast.signInFailed", { message: msg }));
    } finally {
      setSigningIn(false);
    }
  }

  function handleSignOut() {
    setCloudAuth(null, null);
    onToast("ok", t("toast.signOutDone"));
  }

  async function pickFolder() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setProjectRoot(picked);
  }

  function displayName(path: string): string {
    const segments = path.replace(/\/+$/, "").split(/[\\/]/);
    return segments[segments.length - 1] || path;
  }

  const downloading =
    updateProgress?.phase === "downloading" || updateProgress?.phase === "installing";
  const dlTotal = updateProgress?.totalBytes ?? 0;
  const dlPct =
    dlTotal > 0 && updateProgress
      ? Math.min(100, Math.round((updateProgress.downloadedBytes / dlTotal) * 100))
      : null;
  const dlLabel =
    updateProgress?.phase === "installing"
      ? t("settings.about.installing")
      : t("settings.about.downloading", {
          versionSuffix: availableUpdate ? ` v${availableUpdate.version}` : "",
          percentSuffix: dlPct !== null ? ` — ${dlPct}%` : "…",
        });

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h3>{t("settings.title")}</h3>
          <button
            className="settings-close icon-btn"
            aria-label={t("settings.closeAria")}
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-section-title">{t("settings.account.title")}</div>
            {cloudApiKey ? (
              <div className="account-card">
                <div className="account-avatar">
                  {(cloudAccount?.namespace ?? "?").replace(/^@/, "").charAt(0).toUpperCase()}
                </div>
                <div className="account-info">
                  <div className="account-line-1">
                    <span className="account-namespace">{cloudAccount?.namespace ?? "…"}</span>
                    {cloudAccount?.tier && (
                      <span className="badge tier">{cloudAccount.tier}</span>
                    )}
                    {cloudAccount && !cloudAccount.email_verified && (
                      <span className="badge drift">{t("settings.account.unverified")}</span>
                    )}
                  </div>
                  {cloudAccount?.email && (
                    <div className="account-email">{cloudAccount.email}</div>
                  )}
                </div>
                <button className="account-signout" onClick={handleSignOut}>
                  {t("settings.account.signOut")}
                </button>
              </div>
            ) : (
              <div className="account-card account-card-signedout">
                <div className="account-info">
                  <div className="account-namespace">{t("settings.account.notSignedIn")}</div>
                  <div className="account-email">
                    {t("settings.account.signedInHint")}
                  </div>
                </div>
                <button className="primary" onClick={handleSignIn} disabled={signingIn}>
                  {signingIn ? t("settings.account.signingIn") : t("settings.account.signIn")}
                </button>
              </div>
            )}
          </section>

          <div id="settings-backup">
            <BackupPanel onToast={onToast} />
          </div>

          <section id="settings-projects" className="settings-section">
            <div className="settings-section-title-row">
              <div className="settings-section-title">{t("settings.projects.title")}</div>
              <button className="link-btn" onClick={pickFolder}>{t("settings.projects.addButton")}</button>
            </div>
            {recentProjects.length === 0 ? (
              <div className="projects-empty">
                {t("settings.projects.empty", { addLabel: t("settings.projects.addLabel") })}
              </div>
            ) : (
              <ul className="projects-list">
                {recentProjects.map((p) => {
                  const active = p === projectRoot;
                  const name = displayName(p);
                  return (
                    <li
                      key={p}
                      className={`project-item ${active ? "active" : ""}`}
                      onClick={() => setProjectRoot(p)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setProjectRoot(p); } }}
                    >
                      <FolderIcon size={14} />
                      <div className="project-item-text">
                        <div className="project-item-name">{name}</div>
                        <div className="project-item-path">{p}</div>
                      </div>
                      {active && <span className="badge tier">{t("settings.projects.active")}</span>}
                      <button
                        className="project-item-remove"
                        title={t("settings.projects.removeTooltip", { name })}
                        aria-label={t("settings.projects.removeAria", { name })}
                        onClick={(e) => { e.stopPropagation(); removeRecentProject(p); }}
                      >
                        <TrashIcon size={14} />
                        <span className="project-item-remove-text">{t("settings.projects.removeLabel")}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-section-title">{t("settings.about.title")}</div>
            <div className="account-card account-card-signedout">
              <div className="account-info">
                <div className="account-line-1">
                  <span className="account-namespace">{t("settings.about.appName")}</span>
                  <span className="badge tier">v{currentVersion}</span>
                </div>
                <div className="account-email">
                  {availableUpdate && availableUpdate.version !== currentVersion
                    ? t("settings.about.updateAvailable", { version: availableUpdate.version })
                    : t("settings.about.upToDate")}
                </div>
              </div>
              <button onClick={handleCheckForUpdates} disabled={checkingUpdate}>
                {checkingUpdate ? t("settings.about.checking") : t("settings.about.checkButton")}
              </button>
            </div>
            <div className="layout-reset-row" style={{ marginTop: 8 }}>
              <div className="layout-reset-text">
                {t("settings.about.autoUpdateHint")}
              </div>
              <div className="segmented">
                <button
                  className={`segmented-btn ${autoUpdate ? "active" : ""}`}
                  onClick={() => setAutoUpdate(true)}
                >
                  <span>{t("common.on")}</span>
                </button>
                <button
                  className={`segmented-btn ${!autoUpdate ? "active" : ""}`}
                  onClick={() => setAutoUpdate(false)}
                >
                  <span>{t("common.off")}</span>
                </button>
              </div>
            </div>
            {downloading && (
              <div className="layout-reset-row" style={{ marginTop: 8, flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <div className="layout-reset-text">{dlLabel}</div>
                {dlPct !== null && updateProgress?.phase === "downloading" && (
                  <div className="update-progress" aria-hidden="true">
                    <div className="update-progress-bar" style={{ width: `${dlPct}%` }} />
                  </div>
                )}
              </div>
            )}
            {updateReadyToInstall && availableUpdate && (
              <div className="layout-reset-row" style={{ marginTop: 8 }}>
                <div className="layout-reset-text">
                  {t("settings.about.readyToInstall", { version: availableUpdate.version })}
                </div>
                <button className="primary" onClick={handleRestartAndInstall} disabled={restarting}>
                  {restarting
                    ? t("settings.about.restartingInstalling")
                    : t("settings.about.restartAndInstall", { version: availableUpdate.version })}
                </button>
              </div>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-section-title">{t("settings.appearance.title")}</div>
            <div className="segmented">
              <button
                className={`segmented-btn ${theme === "system" ? "active" : ""}`}
                onClick={() => setTheme("system")}
                title={t("settings.appearance.systemTitle")}
              >
                <MonitorIcon size={14} />
                <span>{t("settings.appearance.system")}</span>
              </button>
              <button
                className={`segmented-btn ${theme === "dark" ? "active" : ""}`}
                onClick={() => setTheme("dark")}
              >
                <MoonIcon size={14} />
                <span>{t("settings.appearance.dark")}</span>
              </button>
              <button
                className={`segmented-btn ${theme === "light" ? "active" : ""}`}
                onClick={() => setTheme("light")}
              >
                <SunIcon size={14} />
                <span>{t("settings.appearance.light")}</span>
              </button>
            </div>
          </section>

          <section className="settings-section" id="settings-language">
            <div className="settings-section-title">{t("settings.language.title")}</div>
            <div className="layout-reset-row">
              <div className="layout-reset-text">{t("settings.language.hint")}</div>
              <select
                className="language-select"
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
              >
                {SUPPORTED.map((l) => (
                  <option key={l} value={l}>{NATIVE_NAME[l]}</option>
                ))}
              </select>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">{t("settings.layout.title")}</div>
            <div className="layout-reset-row">
              <div className="layout-reset-text">
                {t("settings.layout.hint")}
              </div>
              <button
                onClick={() => {
                  resetLayout();
                  onToast("ok", t("settings.layout.resetToast"));
                }}
              >
                {t("settings.layout.resetButton")}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useApp } from "../lib/store";
import { fetchAccount, runDeviceFlow } from "../lib/skillsafe/auth";
import { SkillSafeError } from "../lib/skillsafe/client";
import { CloseIcon, FolderIcon, MonitorIcon, MoonIcon, SunIcon, TrashIcon } from "./icons";
import { BackupPanel } from "./BackupPanel";
import { checkForUpdate, installAndRelaunch } from "../lib/update/runner";

interface Props {
  onClose: () => void;
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function SettingsDialog({ onClose, onToast }: Props) {
  const {
    theme,
    setTheme,
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

  // Deep-link: callers can request a section to be scrolled into view
  // (e.g. clicking "Configure & back up…" in the BackupBrowser).
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
        onToast("ok", `You're on the latest version (v${currentVersion}).`);
        return;
      }
      setAvailableUpdate({ version: update.version, notes: update.body ?? "", date: update.date });
      if (autoUpdate) {
        // Stream the download via the same orchestrator path. We trigger the
        // 6h cycle indirectly by showing the user the version is available;
        // a full cycle will pick it up. For an explicit "check" we just
        // download-and-install here so the user gets immediate feedback.
        try {
          await installAndRelaunch(update, setUpdateProgress);
        } catch (e) {
          setUpdateError(e instanceof Error ? e.message : String(e));
          onToast("error", `Update failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        onToast("ok", `Update available: v${update.version}.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onToast("error", `Update check failed: ${msg}`);
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleRestartAndInstall() {
    setRestarting(true);
    try {
      // The pending Update handle lives in the orchestrator (App.tsx) and
      // is not reachable from here, so we re-check and download-and-install
      // fresh. `check()` returns a *new* Update handle each call — its
      // download state is not carried over from any prior check, so calling
      // install() directly would fail with "Update.install called before
      // Update.download". `installAndRelaunch` runs downloadAndInstall.
      const update = await checkForUpdate();
      if (!update) {
        onToast("ok", "Update is no longer available.");
        setUpdateReadyToInstall(false);
        return;
      }
      await installAndRelaunch(update, setUpdateProgress);
    } catch (e) {
      onToast("error", `Install failed: ${e instanceof Error ? e.message : String(e)}`);
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
            () => onToast("ok", "Approve sign-in in your browser…"),
            (e) => {
              console.error("shell.open failed:", e);
              const msg = e instanceof SkillSafeError ? `${e.code}: ${e.message}` : (e instanceof Error ? e.message : String(e));
              onToast("error", `Couldn't open browser (${msg}). Open manually: ${url}`);
            },
          );
        },
      });
      const account = await fetchAccount(apiKey);
      setCloudAuth(apiKey, account);
      onToast("ok", `Signed in as ${account.namespace}`);
    } catch (e) {
      const msg = e instanceof SkillSafeError ? `${e.code}: ${e.message}` : String(e);
      onToast("error", `Sign-in failed: ${msg}`);
    } finally {
      setSigningIn(false);
    }
  }

  function handleSignOut() {
    setCloudAuth(null, null);
    onToast("ok", "Signed out.");
  }

  async function pickFolder() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setProjectRoot(picked);
  }

  function displayName(path: string): string {
    const segments = path.replace(/\/+$/, "").split(/[\\/]/);
    return segments[segments.length - 1] || path;
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h3>Settings</h3>
          <button
            className="settings-close icon-btn"
            aria-label="Close settings"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <div className="settings-body">
          {/* Account */}
          <section className="settings-section">
            <div className="settings-section-title">Account</div>
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
                      <span className="badge drift">unverified</span>
                    )}
                  </div>
                  {cloudAccount?.email && (
                    <div className="account-email">{cloudAccount.email}</div>
                  )}
                </div>
                <button className="account-signout" onClick={handleSignOut}>
                  Sign out
                </button>
              </div>
            ) : (
              <div className="account-card account-card-signedout">
                <div className="account-info">
                  <div className="account-namespace">Not signed in</div>
                  <div className="account-email">
                    Sign in with skillsafe.ai to install, save, and share skills.
                  </div>
                </div>
                <button className="primary" onClick={handleSignIn} disabled={signingIn}>
                  {signingIn ? "Waiting…" : "Sign in"}
                </button>
              </div>
            )}
          </section>

          {/* Local Backup — surfaced near the top because it protects user data
              and the bottom-row Backup panel deep-links here. */}
          <div id="settings-backup">
            <BackupPanel onToast={onToast} />
          </div>

          {/* Projects */}
          <section id="settings-projects" className="settings-section">
            <div className="settings-section-title-row">
              <div className="settings-section-title">Projects</div>
              <button className="link-btn" onClick={pickFolder}>+ Add project…</button>
            </div>
            {recentProjects.length === 0 ? (
              <div className="projects-empty">
                No projects added yet. Click <strong>Add project…</strong> to pick a folder.
                Each project's <code>.claude/</code>, <code>.codex/</code>, <code>.cursor/</code>, or
                <code>.agents/</code> directory is read when you pick the “Project” scope.
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
                      {active && <span className="badge tier">active</span>}
                      <button
                        className="project-item-remove"
                        title={`Remove ${name} from this list (your folder is not deleted)`}
                        aria-label={`Remove ${name}`}
                        onClick={(e) => { e.stopPropagation(); removeRecentProject(p); }}
                      >
                        <TrashIcon size={14} />
                        <span className="project-item-remove-text">Remove</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* About / Updates */}
          <section className="settings-section">
            <div className="settings-section-title">About</div>
            <div className="account-card account-card-signedout">
              <div className="account-info">
                <div className="account-line-1">
                  <span className="account-namespace">AI SkillSafe</span>
                  <span className="badge tier">v{currentVersion}</span>
                </div>
                <div className="account-email">
                  {availableUpdate && availableUpdate.version !== currentVersion
                    ? `Update available: v${availableUpdate.version}`
                    : "You're on the latest version."}
                </div>
              </div>
              <button onClick={handleCheckForUpdates} disabled={checkingUpdate}>
                {checkingUpdate ? "Checking…" : "Check for updates"}
              </button>
            </div>
            <div className="layout-reset-row" style={{ marginTop: 8 }}>
              <div className="layout-reset-text">
                Automatically download new versions in the background and install them on next launch.
              </div>
              <div className="segmented">
                <button
                  className={`segmented-btn ${autoUpdate ? "active" : ""}`}
                  onClick={() => setAutoUpdate(true)}
                >
                  <span>On</span>
                </button>
                <button
                  className={`segmented-btn ${!autoUpdate ? "active" : ""}`}
                  onClick={() => setAutoUpdate(false)}
                >
                  <span>Off</span>
                </button>
              </div>
            </div>
            {(() => {
              const downloading =
                updateProgress?.phase === "downloading" || updateProgress?.phase === "installing";
              if (!downloading) return null;
              const total = updateProgress?.totalBytes ?? 0;
              const pct =
                total > 0 && updateProgress
                  ? Math.min(100, Math.round((updateProgress.downloadedBytes / total) * 100))
                  : null;
              const label =
                updateProgress?.phase === "installing"
                  ? "Installing…"
                  : `Downloading${availableUpdate ? ` v${availableUpdate.version}` : ""}${
                      pct !== null ? ` — ${pct}%` : "…"
                    }`;
              return (
                <div className="layout-reset-row" style={{ marginTop: 8, flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <div className="layout-reset-text">{label}</div>
                  {pct !== null && updateProgress?.phase === "downloading" && (
                    <div className="update-progress" aria-hidden="true">
                      <div className="update-progress-bar" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })()}
            {updateReadyToInstall && availableUpdate && (
              <div className="layout-reset-row" style={{ marginTop: 8 }}>
                <div className="layout-reset-text">
                  v{availableUpdate.version} is downloaded and ready to install.
                </div>
                <button className="primary" onClick={handleRestartAndInstall} disabled={restarting}>
                  {restarting ? "Installing…" : `Restart and install v${availableUpdate.version}`}
                </button>
              </div>
            )}
          </section>

          {/* Appearance */}
          <section className="settings-section">
            <div className="settings-section-title">Appearance</div>
            <div className="segmented">
              <button
                className={`segmented-btn ${theme === "system" ? "active" : ""}`}
                onClick={() => setTheme("system")}
                title="Follow OS preference"
              >
                <MonitorIcon size={14} />
                <span>System</span>
              </button>
              <button
                className={`segmented-btn ${theme === "dark" ? "active" : ""}`}
                onClick={() => setTheme("dark")}
              >
                <MoonIcon size={14} />
                <span>Dark</span>
              </button>
              <button
                className={`segmented-btn ${theme === "light" ? "active" : ""}`}
                onClick={() => setTheme("light")}
              >
                <SunIcon size={14} />
                <span>Light</span>
              </button>
            </div>
          </section>

          {/* Layout */}
          <section className="settings-section">
            <div className="settings-section-title">Layout</div>
            <div className="layout-reset-row">
              <div className="layout-reset-text">
                Reset the sidebar, artifact-list, and bottom-panel sizes to
                their defaults.
              </div>
              <button
                onClick={() => {
                  resetLayout();
                  onToast("ok", "Panel sizes reset to defaults.");
                }}
              >
                Reset panel sizes
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

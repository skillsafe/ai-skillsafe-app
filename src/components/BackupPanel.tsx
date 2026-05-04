import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Command, open as shellOpen } from "@tauri-apps/plugin-shell";
import { type as osType } from "@tauri-apps/plugin-os";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { generateScripts, type BackupPlatform } from "../lib/backup/generateScripts";
import {
  SERVICE_LABEL,
  diagnose as diagnoseSchedule,
  getStatus,
  install as installSchedule,
  readLogTail,
  runNow as runScheduleNow,
  uninstall as uninstallSchedule,
  type DiagnosticResult,
  type LogTail,
  type ScheduleStatus,
} from "../lib/backup/scheduler";
import type { ScheduleSpec } from "../lib/backup/generateScripts";
import type { Tool } from "../lib/artifacts/types";
import { ALL_AGENTS, displayNameOf } from "../lib/agents/registry";
import { FolderIcon } from "./icons";
import { ConfirmDialog } from "./ConfirmDialog";

// Drawn from the registry so a new entry in src/lib/agents/registry.ts
// appears here automatically. Sorted alphabetically by display name to keep
// the picker scannable as the list crosses ~50 entries.
const ALL_TOOLS: ReadonlyArray<{ id: Tool; label: string }> = ALL_AGENTS
  .map((id) => ({ id, label: displayNameOf(id) }))
  .sort((a, b) => a.label.localeCompare(b.label));

interface Props {
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function BackupPanel({ onToast }: Props) {
  const {
    backupDestination,
    backupLastRun,
    backupStats,
    backupBusy,
    backupProgress,
    backupTools,
    backupSchedule,
    setBackupDestination,
    setBackupResult,
    setBackupBusy,
    setBackupProgress,
    setBackupTools,
    setBackupSchedule,
  } = useApp();

  function toggleTool(t: Tool) {
    if (backupTools.includes(t)) {
      const next = backupTools.filter((x) => x !== t);
      // Allow zero tools — the script will no-op and log "nothing to back up".
      setBackupTools(next);
    } else {
      setBackupTools([...backupTools, t]);
    }
  }

  const [generating, setGenerating] = useState(false);
  const [platform, setPlatform] = useState<BackupPlatform>("macos");
  const [scheduleStatus, setScheduleStatus] = useState<ScheduleStatus>({ kind: "not_installed" });
  const [scheduleBusy, setScheduleBusy] = useState<null | "install" | "uninstall" | "run" | "refresh">(
    null,
  );
  const [draftSchedule, setDraftSchedule] = useState<ScheduleSpec>(backupSchedule);
  const [logTail, setLogTail] = useState<LogTail | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [diag, setDiag] = useState<DiagnosticResult | null>(null);
  const [confirmClearDest, setConfirmClearDest] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  // Keep draft synced when persisted schedule changes (e.g. on first load).
  useEffect(() => {
    setDraftSchedule(backupSchedule);
  }, [backupSchedule]);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  // When the user changes the tool selection (or destination), refresh the
  // on-disk script so the next scheduled run picks up the new selection
  // without requiring the user to click "Back up now" or re-install. Best-
  // effort — silent on error, since the toast for "no destination yet" is
  // already surfaced when the user tries to actually run a backup.
  useEffect(() => {
    if (!backupDestination) return;
    if (platform !== "macos") return;
    ensureLocalGenerated().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupTools, backupDestination, backupSchedule, platform]);

  async function probeStatus() {
    const home = await tauriPaths.homeDir();
    const installedPlistPath = await tauriJoiner.join(
      home,
      "Library",
      "LaunchAgents",
      `${SERVICE_LABEL}.plist`,
    );
    return getStatus({
      installedPlistPath,
      exists: (p) => tauriFs.exists(p),
    });
  }

  // Refresh launchd status (macOS only). Re-runs when destination changes
  // because the plist path is derived from it.
  useEffect(() => {
    if (platform !== "macos") return;
    let cancelled = false;
    (async () => {
      try {
        const status = await probeStatus();
        if (!cancelled) setScheduleStatus(status);
      } catch {
        if (!cancelled) setScheduleStatus({ kind: "unsupported" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, backupDestination, backupLastRun]);

  async function runDiagnose() {
    try {
      const home = await tauriPaths.homeDir();
      const installedPlistPath = await tauriJoiner.join(
        home,
        "Library",
        "LaunchAgents",
        `${SERVICE_LABEL}.plist`,
      );
      const scriptPath = await tauriJoiner.join(
        home,
        "Library",
        "Application Support",
        "skillsafe-app",
        "scheduled-backup",
        "claude_backup.sh",
      );
      const result = await diagnoseSchedule({
        installedPlistPath,
        exists: (p) => tauriFs.exists(p),
        scriptPath,
      });
      setDiag(result);
    } catch (e) {
      onToast("error", `Diagnose failed: ${describeErr(e)}`);
    }
  }

  async function refreshSchedule() {
    setScheduleBusy("refresh");
    try {
      const status = await probeStatus();
      setScheduleStatus(status);
      await refreshLog();
    } catch (e) {
      onToast("error", `Status check failed: ${describeErr(e)}`);
    } finally {
      setScheduleBusy(null);
    }
  }

  async function refreshLog() {
    try {
      const home = await tauriPaths.homeDir();
      const logPath = await tauriJoiner.join(home, "Library", "Logs", "skillsafe-backup.log");
      const tail = await readLogTail(
        (p) => tauriFs.readTextFile(p),
        (p) => tauriFs.exists(p),
        logPath,
        80,
      );
      setLogTail(tail);
    } catch {
      setLogTail(null);
    }
  }

  // Load log tail once on mount (and on platform change).
  useEffect(() => {
    if (platform !== "macos") return;
    refreshLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  async function ensureLocalGenerated(
    schedule: ScheduleSpec = backupSchedule,
  ): Promise<{ scriptPath: string; plistPath: string }> {
    if (!backupDestination) throw new Error("Pick a destination folder first.");
    const home = await tauriPaths.homeDir();
    // Local copy: lives outside OneDrive/Dropbox/etc so launchd can read it
    // even when the cloud destination is offline or cloud-only-stub.
    const localOutDir = await tauriJoiner.join(
      home,
      "Library",
      "Application Support",
      "skillsafe-app",
      "scheduled-backup",
    );
    await generateScripts({
      fs: tauriFs,
      joiner: tauriJoiner,
      platform: "macos",
      home,
      destination: backupDestination,
      outDir: localOutDir,
      schedule,
      tools: backupTools,
    });
    const scriptPath = await tauriJoiner.join(localOutDir, "claude_backup.sh");
    const plistPath = await tauriJoiner.join(localOutDir, `${SERVICE_LABEL}.plist`);
    return { scriptPath, plistPath };
  }

  async function handleScheduleInstall() {
    setScheduleBusy("install");
    try {
      // Use the LOCAL copy — its plist references a script outside OneDrive,
      // so launchctl bootstrap can validate the path even when the cloud
      // destination is offline / cloud-only.
      const { plistPath } = await ensureLocalGenerated();
      const sourcePlistContents = await tauriFs.readTextFile(plistPath);
      const home = await tauriPaths.homeDir();
      const launchAgentsDir = await tauriJoiner.join(home, "Library", "LaunchAgents");
      // Fresh macOS user accounts don't have ~/Library/LaunchAgents until
      // something installs into it. Create it ourselves so writeFile can land.
      await tauriFs.mkdir(launchAgentsDir, { recursive: true });
      const installedPlistPath = await tauriJoiner.join(
        launchAgentsDir,
        `${SERVICE_LABEL}.plist`,
      );
      await installSchedule({
        sourcePlistContents,
        installedPlistPath,
        writeFile: (p, c) => tauriFs.writeTextFile(p, c),
      });
      const status = await probeStatus();
      setScheduleStatus(status);
      onToast("ok", "Daily backup installed. It will run at 12:15 each day.");
    } catch (e) {
      onToast("error", `Install failed: ${describeErr(e)}`);
    } finally {
      setScheduleBusy(null);
    }
  }

  async function handleScheduleUninstall() {
    setScheduleBusy("uninstall");
    try {
      const home = await tauriPaths.homeDir();
      const installedPlistPath = await tauriJoiner.join(
        home,
        "Library",
        "LaunchAgents",
        `${SERVICE_LABEL}.plist`,
      );
      const result = await uninstallSchedule({
        installedPlistPath,
        exists: (p) => tauriFs.exists(p),
        removeFile: (p) => tauriFs.remove(p),
      });
      const status = await probeStatus();
      setScheduleStatus(status);
      if (result.removed) {
        onToast("ok", "Daily backup uninstalled.");
      } else {
        // bootout already stopped the service. macOS just blocks Tauri from
        // deleting files in ~/Library/LaunchAgents/. Hand the user a copy-
        // pasteable command they can run themselves.
        onToast(
          "error",
          `Service stopped, but macOS blocked the plist removal. Run this in Terminal to finish cleanup:\n\n${result.manualCommand}\n\n(${result.reason ?? "Operation not permitted"})`,
        );
      }
    } catch (e) {
      onToast("error", `Uninstall failed: ${describeErr(e)}`);
    } finally {
      setScheduleBusy(null);
    }
  }

  async function handleScheduleRunNow() {
    setScheduleBusy("run");
    try {
      await runScheduleNow();
      onToast("ok", "Triggered scheduled backup.");
      // Re-poll status after a short delay so the user sees the running PID.
      setTimeout(() => {
        probeStatus().then(setScheduleStatus).catch(() => {});
      }, 400);
      // Refresh the log shortly after — the script logs an opening line at
      // the top of every run so the user sees activity even before files copy.
      setTimeout(() => { refreshLog(); }, 1500);
    } catch (e) {
      onToast("error", `Run failed: ${describeErr(e)}`);
    } finally {
      setScheduleBusy(null);
    }
  }

  async function handleApplySchedule() {
    if (!isValidSchedule(draftSchedule)) {
      onToast("error", "Hour must be 0–23 and minute must be 0–59.");
      return;
    }
    setBackupSchedule(draftSchedule);
    if (scheduleStatus.kind !== "loaded") {
      onToast("ok", "Schedule saved. Click Install daily backup to apply.");
      return;
    }
    // Already installed — re-install with the new plist.
    setScheduleBusy("install");
    try {
      const { plistPath } = await ensureLocalGenerated(draftSchedule);
      const sourcePlistContents = await tauriFs.readTextFile(plistPath);
      const home = await tauriPaths.homeDir();
      const launchAgentsDir = await tauriJoiner.join(home, "Library", "LaunchAgents");
      await tauriFs.mkdir(launchAgentsDir, { recursive: true });
      const installedPlistPath = await tauriJoiner.join(
        launchAgentsDir,
        `${SERVICE_LABEL}.plist`,
      );
      await installSchedule({
        sourcePlistContents,
        installedPlistPath,
        writeFile: (p, c) => tauriFs.writeTextFile(p, c),
      });
      const status = await probeStatus();
      setScheduleStatus(status);
      onToast("ok", "Schedule updated.");
    } catch (e) {
      onToast("error", `Schedule update failed: ${describeErr(e)}`);
    } finally {
      setScheduleBusy(null);
    }
  }

  function setDraftHour(v: number) {
    setDraftSchedule((d) => ({ ...d, hour: clamp(v, 0, 23) }));
  }
  function setDraftMinute(v: number) {
    setDraftSchedule((d) => ({ ...d, minute: clamp(v, 0, 59) }));
  }
  function toggleDraftWeekday(day: number) {
    setDraftSchedule((d) => {
      const cur = d.weekdays ?? [];
      const next = cur.includes(day)
        ? cur.filter((x) => x !== day)
        : [...cur, day].sort((a, b) => a - b);
      return { ...d, weekdays: next.length === 0 ? null : next };
    });
  }

  const scheduleDirty =
    draftSchedule.hour !== backupSchedule.hour ||
    draftSchedule.minute !== backupSchedule.minute ||
    !weekdaysEqual(draftSchedule.weekdays ?? null, backupSchedule.weekdays ?? null);

  async function browseBackupFolder() {
    if (!backupStats?.backupRoot) {
      onToast("error", "Run a backup first.");
      return;
    }
    try {
      await shellOpen(backupStats.backupRoot);
    } catch (e) {
      onToast("error", `Open failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function openEntry(destPath: string) {
    try {
      await shellOpen(destPath);
    } catch (e) {
      onToast("error", `Open failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function pickDestination() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setBackupDestination(picked);
  }

  async function handleBackup() {
    if (!backupDestination) {
      onToast("error", "Pick a destination folder first.");
      return;
    }
    setBackupBusy(true);
    setBackupProgress({
      phase: "running script",
      filesProcessed: 0,
      filesCopied: 0,
      bytesProcessed: 0,
      bytesCopied: 0,
    });
    try {
      // Always regenerate first so the script reflects the current destination
      // and schedule. Then exec the same script launchd would have run, so
      // manual + scheduled paths share one implementation.
      const { scriptPath } = await ensureLocalGenerated();
      const out = await Command.create("bash", [scriptPath]).execute();
      // Script exit codes: 0 = clean, 2 = ran with non-fatal failures (logged),
      // anything else = fatal (e.g. destination missing).
      if (out.code !== 0 && out.code !== 2) {
        throw new Error(out.stderr || out.stdout || `exit code ${out.code}`);
      }
      const generatedAt = Date.now();
      setBackupResult(generatedAt, {
        generatedAt,
        counts: { added: 0, changed: 0, removed: 0, unchanged: 0 },
        totalBytes: 0,
        errorCount: 0,
        errorSamples: [],
        recentChanges: [],
        backupRoot: backupDestination,
      });
      refreshLog();
      if (out.code === 2) {
        onToast("error", "Backup completed with errors. Check the log.");
      } else {
        onToast("ok", "Backup complete.");
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      onToast("error", `Backup failed: ${friendlyBackupError(raw)}`);
    } finally {
      setBackupBusy(false);
      setBackupProgress(null);
    }
  }

  async function handleGenerateScript() {
    if (!backupDestination) {
      onToast("error", "Pick a destination folder first.");
      return;
    }
    setGenerating(true);
    try {
      const platform = detectPlatform();
      const home = await tauriPaths.homeDir();
      // Generate the script + plist under our app-support dir, never inside
      // the user's cloud-synced backup folder. Cloud daemons (OneDrive,
      // Dropbox) introduce permission and sync-lock issues for executable
      // shell scripts and plists, and putting the runner inside the same
      // folder it writes to creates needless coupling. The script still
      // mirrors TO the user's chosen destination at runtime.
      const outDir = await tauriJoiner.join(
        home,
        "Library",
        "Application Support",
        "skillsafe-app",
        "scheduled-backup",
      );
      const result = await generateScripts({
        fs: tauriFs,
        joiner: tauriJoiner,
        platform,
        home,
        destination: backupDestination,
        outDir,
        tools: backupTools,
      });
      onToast("ok", `Generated ${result.files.length} files in ${outDir}`);
      shellOpen(outDir).catch(() => {});
    } catch (e) {
      onToast("error", `Script generation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title">Local Backup</div>

      {/* Backup folder card — the most prominent setting. Without a folder
          the "Back up now" button is disabled, so we want this to read like
          a clear call to action when empty and a status card when filled. */}
      <div className={`backup-folder-card ${backupDestination ? "" : "empty"}`}>
        <div className="backup-folder-icon" aria-hidden="true">
          <FolderIcon size={18} />
        </div>
        <div className="backup-folder-text">
          <div className="backup-folder-label">Backup folder</div>
          {backupDestination ? (
            <div className="backup-folder-path" title={backupDestination}>
              {backupDestination}
            </div>
          ) : (
            <div className="backup-folder-hint">
              Pick a folder inside your OneDrive / Dropbox / iCloud Drive to
              back up to.
            </div>
          )}
        </div>
        <div className="backup-folder-actions">
          {backupDestination ? (
            <>
              <button className="link-btn" onClick={pickDestination} title="Pick a different folder">
                Change…
              </button>
              <button
                className="link-btn"
                onClick={browseBackupFolder}
                title="Open the backup folder in Finder/Explorer"
                disabled={!backupStats?.backupRoot}
              >
                Open folder
              </button>
              <button
                className="link-btn"
                onClick={() => setConfirmClearDest(true)}
                title="Forget destination (does not delete files)"
              >
                Clear
              </button>
            </>
          ) : (
            <button className="primary" onClick={pickDestination}>
              Choose folder…
            </button>
          )}
        </div>
      </div>

      <div className="settings-row" style={{ alignItems: "flex-start" }}>
        <label className="settings-row-label">Tools</label>
        <div className="pill-row" style={{ flex: 1, flexWrap: "wrap" }}>
          {ALL_TOOLS.map((t) => (
            <div
              key={t.id}
              className={`pill ${backupTools.includes(t.id) ? "active" : ""}`}
              onClick={() => toggleTool(t.id)}
              role="checkbox"
              aria-checked={backupTools.includes(t.id)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  toggleTool(t.id);
                }
              }}
            >
              {t.label}
            </div>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <button
          className="primary"
          onClick={handleBackup}
          disabled={!backupDestination || backupBusy}
          title={
            !backupDestination
              ? "Pick a backup folder above to enable backups"
              : backupBusy
                ? "Backup in progress…"
                : "Run a one-time backup of the selected tools"
          }
        >
          {backupBusy ? "Backing up…" : "Back up now"}
        </button>
      </div>

      {backupBusy && backupProgress && (
        <div className="dl-progress" role="status" aria-live="polite">
          <div className="dl-progress-bar">
            {/* Indeterminate animated bar — we don't pre-count files. */}
            <div className="dl-progress-fill backup-progress-indeterminate" />
          </div>
          <div className="dl-progress-label">
            {backupProgress.phase} · scanned {backupProgress.filesProcessed}{" "}
            ({formatBytes(backupProgress.bytesProcessed)}) · copied{" "}
            {backupProgress.filesCopied} ({formatBytes(backupProgress.bytesCopied)})
          </div>
        </div>
      )}

      {backupLastRun && backupStats && (
        <div className="projects-summary-text" style={{ paddingLeft: 6 }}>
          <div>
            Last backup: {formatRelative(backupLastRun)} · +{backupStats.counts.added} ~
            {backupStats.counts.changed} -{backupStats.counts.removed} ·{" "}
            {formatBytes(backupStats.totalBytes)}
            {backupStats.errorCount > 0 && (
              <span className="badge drift" style={{ marginLeft: 8 }}>
                {backupStats.errorCount} error{backupStats.errorCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {backupStats.errorSamples && backupStats.errorSamples.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer", color: "var(--error)" }}>
                Show {backupStats.errorSamples.length === backupStats.errorCount
                  ? `${backupStats.errorCount} error${backupStats.errorCount === 1 ? "" : "s"}`
                  : `first ${backupStats.errorSamples.length} of ${backupStats.errorCount}`}
              </summary>
              <pre
                style={{
                  marginTop: 4,
                  padding: 8,
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  userSelect: "text",
                  maxHeight: 200,
                  overflow: "auto",
                }}
              >
                {backupStats.errorSamples.join("\n")}
              </pre>
            </details>
          )}
          {backupStats.recentChanges && backupStats.recentChanges.length > 0 && (
            <details style={{ marginTop: 6 }} open>
              <summary style={{ cursor: "pointer" }}>
                Recent changes ({backupStats.recentChanges.length}
                {backupStats.counts.added + backupStats.counts.changed >
                  backupStats.recentChanges.length
                  ? ` of ${backupStats.counts.added + backupStats.counts.changed}`
                  : ""}
                )
              </summary>
              <ul
                style={{
                  marginTop: 4,
                  padding: 8,
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 11,
                  listStyle: "none",
                  maxHeight: 240,
                  overflow: "auto",
                }}
              >
                {backupStats.recentChanges.map((c) => (
                  <li
                    key={c.destPath}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 0",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: c.status === "added" ? "#3aaf5a" : "#d4a017",
                        flexShrink: 0,
                      }}
                      title={c.status}
                    />
                    <button
                      className="link-btn"
                      onClick={() => openEntry(c.destPath)}
                      title={`Open ${c.destPath}`}
                      style={{
                        textAlign: "left",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                        minWidth: 0,
                        padding: 0,
                      }}
                    >
                      {c.relPath}
                    </button>
                    <span
                      style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}
                    >
                      {formatBytes(c.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Daily schedule (macOS launchd) */}
      <div className="settings-section-title-row" style={{ marginTop: 12 }}>
        <div className="settings-section-title" style={{ fontSize: 12 }}>
          Daily schedule
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="link-btn"
            onClick={handleGenerateScript}
            disabled={!backupDestination || generating}
            title="Emit a daily-backup script + scheduler config you can install yourself"
          >
            {generating ? "Generating…" : "Export script…"}
          </button>
          <button
            className="link-btn"
            onClick={refreshSchedule}
            disabled={!!scheduleBusy || platform !== "macos"}
            title="Refresh launchd status"
          >
            {scheduleBusy === "refresh" ? "Checking…" : "Refresh"}
          </button>
          <button
            className="link-btn"
            onClick={runDiagnose}
            disabled={platform !== "macos"}
            title="Run all status probes and dump raw output for debugging"
          >
            Diagnose
          </button>
        </div>
      </div>
      {platform !== "macos" ? (
        <div className="projects-empty">
          In-app scheduling is macOS-only. On Windows, click{" "}
          <strong>Export script…</strong> above and run{" "}
          <code>register-task.ps1</code> as Administrator once.
        </div>
      ) : (
        <>
          <div className="settings-row">
            <span style={{ flex: 1, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    scheduleStatus.kind === "loaded"
                      ? scheduleStatus.pid && scheduleStatus.pid > 0
                        ? "#3aaf5a"
                        : "var(--accent)"
                      : scheduleStatus.kind === "unsupported"
                        ? "var(--muted)"
                        : "#d4a017",
                  flexShrink: 0,
                }}
              />
              {scheduleStatusLabel(scheduleStatus)}
            </span>
            <div className="settings-row-actions">
              {scheduleStatus.kind === "loaded" ? (
                <>
                  <button
                    className="primary"
                    onClick={handleScheduleRunNow}
                    disabled={!!scheduleBusy}
                  >
                    {scheduleBusy === "run" ? "Running…" : "Run now"}
                  </button>
                  <button
                    className="link-btn"
                    onClick={() => setConfirmUninstall(true)}
                    disabled={!!scheduleBusy}
                  >
                    {scheduleBusy === "uninstall" ? "Uninstalling…" : "Uninstall"}
                  </button>
                </>
              ) : scheduleStatus.kind === "installed_not_loaded" ? (
                <>
                  <button
                    className="primary"
                    onClick={handleScheduleInstall}
                    disabled={!!scheduleBusy}
                    title="Re-load the plist into launchd"
                  >
                    {scheduleBusy === "install" ? "Reloading…" : "Reload"}
                  </button>
                  <button
                    className="link-btn"
                    onClick={() => setConfirmUninstall(true)}
                    disabled={!!scheduleBusy}
                  >
                    {scheduleBusy === "uninstall" ? "Uninstalling…" : "Uninstall"}
                  </button>
                </>
              ) : (
                <button
                  className="primary"
                  onClick={handleScheduleInstall}
                  disabled={!!scheduleBusy || !backupDestination}
                  title={
                    backupDestination
                      ? "Install a launchd job that runs the backup daily at 12:15"
                      : "Pick a destination first"
                  }
                >
                  {scheduleBusy === "install" ? "Installing…" : "Install daily backup"}
                </button>
              )}
            </div>
          </div>
          <div className="projects-summary-text" style={{ fontSize: 11, paddingLeft: 6 }}>
            Service: <code>{SERVICE_LABEL}</code> ·{" "}
            {scheduleSummary(backupSchedule)}
          </div>

          {/* Schedule editor — change the time / weekdays. Pressing Apply
              persists the schedule and (if currently loaded) re-installs the
              plist so launchd picks up the new times. */}
          <div className="settings-section-title-row" style={{ marginTop: 10 }}>
            <div className="settings-section-title" style={{ fontSize: 12 }}>
              Schedule
            </div>
            {scheduleDirty && (
              <button
                className="link-btn"
                onClick={() => setDraftSchedule(backupSchedule)}
                title="Discard pending changes"
              >
                Reset
              </button>
            )}
          </div>
          <div
            className="settings-row"
            style={{ alignItems: "center", flexWrap: "wrap", gap: 8 }}
          >
            <label className="settings-row-label" style={{ minWidth: 60 }}>
              Time
            </label>
            <input
              type="number"
              min={0}
              max={23}
              value={draftSchedule.hour}
              onChange={(e) => setDraftHour(parseInt(e.target.value, 10))}
              className="settings-select"
              style={{ width: 64 }}
              aria-label="Hour"
            />
            <span style={{ color: "var(--muted)" }}>:</span>
            <input
              type="number"
              min={0}
              max={59}
              value={draftSchedule.minute}
              onChange={(e) => setDraftMinute(parseInt(e.target.value, 10))}
              className="settings-select"
              style={{ width: 64 }}
              aria-label="Minute"
            />
            <span style={{ color: "var(--muted)", fontSize: 11 }}>
              24-hour, local time
            </span>
          </div>
          <div className="settings-row" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <label className="settings-row-label" style={{ minWidth: 60 }}>
              Days
            </label>
            <div className="pill-row" style={{ flexWrap: "wrap" }}>
              {WEEKDAY_LABELS.map((label, i) => {
                const active =
                  (draftSchedule.weekdays ?? []).length === 0
                    ? false
                    : (draftSchedule.weekdays ?? []).includes(i);
                return (
                  <div
                    key={label}
                    className={`pill ${active ? "active" : ""}`}
                    role="checkbox"
                    aria-checked={active}
                    onClick={() => toggleDraftWeekday(i)}
                    title={label}
                  >
                    {label}
                  </div>
                );
              })}
              <span style={{ fontSize: 11, color: "var(--muted)", alignSelf: "center", marginLeft: 6 }}>
                {(draftSchedule.weekdays ?? []).length === 0
                  ? "every day"
                  : `${(draftSchedule.weekdays ?? []).length} day${(draftSchedule.weekdays ?? []).length === 1 ? "" : "s"} selected`}
              </span>
            </div>
          </div>
          {scheduleDirty && (
            <div className="settings-row">
              <button
                className="primary"
                onClick={handleApplySchedule}
                disabled={!!scheduleBusy}
              >
                {scheduleBusy === "install" ? "Applying…" : "Apply schedule"}
              </button>
            </div>
          )}

          {/* Log tail — last lines from ~/Library/Logs/skillsafe-backup.log */}
          <div className="settings-section-title-row" style={{ marginTop: 10 }}>
            <div className="settings-section-title" style={{ fontSize: 12 }}>
              Log
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="link-btn"
                onClick={() => setShowLog((s) => !s)}
                disabled={!logTail}
              >
                {showLog ? "Hide" : "Show"}
              </button>
              <button className="link-btn" onClick={refreshLog}>
                Reload
              </button>
              {logTail && (
                <button
                  className="link-btn"
                  onClick={async () => {
                    try {
                      const home = await tauriPaths.homeDir();
                      const logPath = await tauriJoiner.join(
                        home,
                        "Library",
                        "Logs",
                        "skillsafe-backup.log",
                      );
                      shellOpen(logPath).catch(() => {});
                    } catch (e) {
                      onToast("error", `Open failed: ${describeErr(e)}`);
                    }
                  }}
                >
                  Open externally
                </button>
              )}
            </div>
          </div>
          {!logTail ? (
            <div className="projects-empty" style={{ fontSize: 11 }}>
              No log yet. Once the schedule has run at least once,
              ~/Library/Logs/skillsafe-backup.log will show its output here.
            </div>
          ) : showLog ? (
            <pre
              style={{
                margin: 0,
                padding: 8,
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 11,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                userSelect: "text",
                maxHeight: 240,
                overflow: "auto",
              }}
            >
              {logTail.text || "(empty)"}
            </pre>
          ) : (
            <div className="projects-summary-text" style={{ fontSize: 11, paddingLeft: 6 }}>
              {logTail.truncated ? "Last 80 lines available" : "Log available"} · {formatBytes(logTail.bytes)}
            </div>
          )}

          {diag && (
            <details style={{ marginTop: 10 }} open>
              <summary style={{ cursor: "pointer", fontSize: 12 }}>
                Diagnostics
                <button
                  className="link-btn"
                  onClick={(e) => { e.preventDefault(); setDiag(null); }}
                  style={{ marginLeft: 8, fontSize: 11, padding: "2px 6px" }}
                >
                  Hide
                </button>
              </summary>
              <pre
                style={{
                  marginTop: 6,
                  padding: 8,
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  userSelect: "text",
                  maxHeight: 300,
                  overflow: "auto",
                }}
              >
                {formatDiagnostics(diag)}
              </pre>
            </details>
          )}
        </>
      )}

      {confirmClearDest && (
        <ConfirmDialog
          title="Forget backup folder?"
          message={
            <>
              <div>
                The path will be removed from settings, but your existing
                backup files are not deleted:
              </div>
              <div className="confirm-target-path">{backupDestination}</div>
              <div className="confirm-warning" style={{ marginTop: 8 }}>
                Manual and scheduled backups will stop until you set a new
                folder.
              </div>
            </>
          }
          confirmLabel="Forget folder"
          danger
          onConfirm={() => {
            setBackupDestination(null);
            setConfirmClearDest(false);
          }}
          onCancel={() => setConfirmClearDest(false)}
        />
      )}

      {confirmUninstall && (
        <ConfirmDialog
          title="Uninstall daily backup?"
          message={
            <>
              <div>
                The launchd job <code>{SERVICE_LABEL}</code> will be stopped
                and removed. Your backup folder and existing files are not
                deleted.
              </div>
              <div className="confirm-warning" style={{ marginTop: 8 }}>
                Backups will no longer run automatically until you reinstall
                the schedule.
              </div>
            </>
          }
          confirmLabel="Uninstall"
          danger
          busy={scheduleBusy === "uninstall"}
          onConfirm={() => {
            setConfirmUninstall(false);
            handleScheduleUninstall();
          }}
          onCancel={() => {
            if (scheduleBusy === "uninstall") return;
            setConfirmUninstall(false);
          }}
        />
      )}
    </section>
  );
}

function scheduleStatusLabel(s: ScheduleStatus): string {
  if (s.kind === "not_installed") return "Not installed";
  if (s.kind === "unsupported") return "launchd not available on this system";
  if (s.kind === "installed_not_loaded") return "Installed · launchd hasn't picked it up yet";
  // loaded
  if (s.pid !== null && s.pid > 0) return `Running (PID ${s.pid})`;
  if (s.lastExitCode !== null && s.lastExitCode !== 0) {
    return `Loaded · last run exited ${s.lastExitCode}`;
  }
  return "Loaded · idle";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));
}
function isValidSchedule(s: ScheduleSpec): boolean {
  if (s.hour < 0 || s.hour > 23 || !Number.isFinite(s.hour)) return false;
  if (s.minute < 0 || s.minute > 59 || !Number.isFinite(s.minute)) return false;
  return true;
}
function weekdaysEqual(a: number[] | null, b: number[] | null): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function scheduleSummary(s: ScheduleSpec): string {
  const hh = String(s.hour).padStart(2, "0");
  const mm = String(s.minute).padStart(2, "0");
  const days = s.weekdays ?? [];
  if (days.length === 0) return `Runs daily at ${hh}:${mm}.`;
  if (days.length === 7) return `Runs daily at ${hh}:${mm}.`;
  const labels = days.map((d) => WEEKDAY_LABELS[d]).join(", ");
  return `Runs at ${hh}:${mm} on ${labels}.`;
}

function formatDiagnostics(d: DiagnosticResult): string {
  const lines: string[] = [
    `uid: ${d.uid ?? "(unknown)"}`,
    `installed plist: ${d.installedPlistPath}`,
    `installed plist exists: ${d.installedPlistExists}`,
    `script path: ${d.scriptPath ?? "(unknown)"}`,
    `script exists: ${d.scriptExists ?? "(unchecked)"}`,
    "",
    `# plutil -lint  (exit ${d.lintCode})`,
    d.lintOutput || "(no output)",
    "",
    `# launchctl list ${SERVICE_LABEL}  (exit ${d.listCode})`,
    d.listOutput || "(no output)",
    "",
    `# launchctl print gui/<uid>/${SERVICE_LABEL}  (exit ${d.printCode})`,
    d.printOutput || "(no output)",
    "",
    `# launchctl print-disabled gui/<uid> | grep ${SERVICE_LABEL}  (exit ${d.disabledOverridesCode})`,
    d.disabledOverridesOutput || "(no output)",
  ];
  if (d.installTranscript && d.installTranscript.length > 0) {
    lines.push("", "# install transcript (most recent install attempt)");
    for (const step of d.installTranscript) {
      lines.push(
        "",
        `$ ${step.cmd} ${step.args.join(" ")}  (exit ${step.code})`,
        step.stdout ? `stdout: ${step.stdout}` : "(stdout empty)",
        step.stderr ? `stderr: ${step.stderr}` : "(stderr empty)",
      );
    }
  } else {
    lines.push("", "# install transcript", "(no install attempt this session)");
  }
  return lines.join("\n");
}

function describeErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Translate Tauri capability rejections into language a user can act on.
// The raw form ("forbidden path: …, maybe it is not allowed on the scope
// for `allow-exists` permission in your capability file") leaks framework
// internals and offers no remediation.
function friendlyBackupError(raw: string): string {
  const m = /forbidden path:\s*([^,]+)/i.exec(raw);
  if (m) {
    const path = m[1].trim();
    return (
      `The backup folder ${path} is outside the locations the app is ` +
      `allowed to write to. Move it to a folder under your home directory ` +
      `or a synced cloud folder (OneDrive, Dropbox, iCloud Drive) and ` +
      `pick it again via Change…`
    );
  }
  return raw;
}

function detectPlatform(): BackupPlatform {
  try {
    const t = osType();
    if (t === "windows") return "windows";
    return "macos";
  } catch {
    return "macos";
  }
}

function formatRelative(ts: number): string {
  const ms = Date.now() - ts;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

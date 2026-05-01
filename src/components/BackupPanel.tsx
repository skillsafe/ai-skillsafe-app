import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { type as osType } from "@tauri-apps/plugin-os";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { runBackup } from "../lib/backup/runBackup";
import { generateScripts, type BackupPlatform } from "../lib/backup/generateScripts";
import { summarize } from "../lib/backup/manifest";
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
import { FolderIcon } from "./icons";

const ALL_TOOLS: ReadonlyArray<{ id: Tool; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "openclaw", label: "OpenClaw" },
  { id: "cline", label: "Cline" },
  { id: "hermes", label: "Hermes" },
];

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
    recentProjects,
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
      setBackupTools(next.length === 0 ? ["claude"] : next);
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

  // Keep draft synced when persisted schedule changes (e.g. on first load).
  useEffect(() => {
    setDraftSchedule(backupSchedule);
  }, [backupSchedule]);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

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
      const installedPlistPath = await tauriJoiner.join(
        home,
        "Library",
        "LaunchAgents",
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
      const installedPlistPath = await tauriJoiner.join(
        home,
        "Library",
        "LaunchAgents",
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
      phase: "starting",
      filesProcessed: 0,
      filesCopied: 0,
      bytesProcessed: 0,
      bytesCopied: 0,
    });
    // Throttle progress updates: runBackup fires per file, which can be
    // thousands per second. Re-rendering React that often is wasteful — coalesce
    // to ~20 fps via a trailing rAF-style microtask.
    let lastTick = 0;
    type ProgressTick = {
      phase: string;
      filesProcessed: number;
      filesCopied: number;
      bytesProcessed: number;
      bytesCopied: number;
    };
    let pending: ProgressTick | null = null;
    function onProgress(p: ProgressTick) {
      pending = p;
      const now = Date.now();
      if (now - lastTick < 50) return;
      lastTick = now;
      setBackupProgress(pending);
    }
    try {
      const manifest = await runBackup({
        fs: tauriFs,
        paths: tauriPaths,
        joiner: tauriJoiner,
        destination: backupDestination,
        tools: backupTools,
        recentProjects,
        onProgress,
      });
      // Flush any final pending state.
      if (pending) setBackupProgress(pending);
      const stats = summarize(manifest);
      setBackupResult(stats.generatedAt, stats);
      const { added, changed, removed } = stats.counts;
      if (manifest.errors.length > 0) {
        onToast(
          "error",
          `Backup finished with ${manifest.errors.length} error(s). +${added} ~${changed} -${removed}.`,
        );
      } else {
        onToast(
          "ok",
          `Backup complete: +${added} added, ~${changed} changed, -${removed} removed.`,
        );
      }
    } catch (e) {
      onToast("error", `Backup failed: ${e instanceof Error ? e.message : String(e)}`);
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
                onClick={() => setBackupDestination(null)}
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
                    onClick={handleScheduleUninstall}
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
                    onClick={handleScheduleUninstall}
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

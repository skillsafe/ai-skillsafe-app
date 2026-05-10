import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Command, open as shellOpen } from "@tauri-apps/plugin-shell";
import { type as osType } from "@tauri-apps/plugin-os";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import {
  generateScripts,
  resolveRestoreMappings,
  type BackupPlatform,
} from "../lib/backup/generateScripts";
import { dataTypesFor, EXTRA_SOURCES } from "../lib/backup/dataTypes";
import { scanForConflicts, type ConflictItem } from "../lib/backup/restoreScan";
import { applyRestore } from "../lib/backup/restoreApply";
import { aggregateToolManifests } from "../lib/backup/aggregate";
import { MANIFEST_FILENAME, summarize } from "../lib/backup/manifest";
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
import {
  WIN_TASK_NAME,
  winDiagnose,
  winGetStatus,
  winInstall,
  winRunNow,
  winUninstall,
  type WinDiagnosticResult,
} from "../lib/backup/winScheduler";
import {
  LINUX_CRON_MARKER,
  linuxDiagnose,
  linuxGetStatus,
  linuxInstall,
  linuxRunNow,
  linuxUninstall,
  type LinuxDiagnosticResult,
} from "../lib/backup/linuxScheduler";
import type { ScheduleSpec } from "../lib/backup/generateScripts";
import type { Tool } from "../lib/artifacts/types";
import { ALL_AGENTS, displayNameOf } from "../lib/agents/registry";
import { FolderIcon } from "./icons";
import { ConfirmDialog } from "./ConfirmDialog";

// Combines the agent registry with the EXTRA_SOURCES list (e.g. shared
// folders like ~/.agents/ that several tools symlink into). Both behave
// uniformly downstream — the picker, dataTypesFor, and resolveSections all
// accept either kind of id.
const ALL_TOOLS: ReadonlyArray<{ id: Tool; label: string; tooltip?: string }> = [
  ...ALL_AGENTS.map((id) => ({ id, label: displayNameOf(id) })),
  ...Object.values(EXTRA_SOURCES).map((s) => ({
    id: s.id,
    label: s.displayName,
    tooltip: s.hoverDescription,
  })),
].sort((a, b) => a.label.localeCompare(b.label));

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
    backupDataTypes,
    backupSchedule,
    setBackupDestination,
    setBackupResult,
    setBackupBusy,
    setBackupProgress,
    setBackupTools,
    setBackupDataTypes,
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
  // Detect platform synchronously so the auto-regenerate effect below doesn't
  // briefly run with the wrong target (e.g. emit `.sh` on Windows on first
  // render before a useEffect could correct the value).
  const [platform] = useState<BackupPlatform>(detectPlatform);
  const [scheduleStatus, setScheduleStatus] = useState<ScheduleStatus>({ kind: "not_installed" });
  const [scheduleBusy, setScheduleBusy] = useState<null | "install" | "uninstall" | "run" | "refresh">(
    null,
  );
  const [draftSchedule, setDraftSchedule] = useState<ScheduleSpec>(backupSchedule);
  const [logTail, setLogTail] = useState<LogTail | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [diag, setDiag] = useState<
    DiagnosticResult | WinDiagnosticResult | LinuxDiagnosticResult | null
  >(null);
  const [confirmClearDest, setConfirmClearDest] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [restoreState, setRestoreState] = useState<
    | { phase: "idle" }
    | { phase: "scanning"; mirror: boolean }
    | {
        phase: "preview";
        conflicts: ConflictItem[];
        selected: Set<string>;
        mirror: boolean;
      }
    | {
        phase: "applying";
        total: number;
        done: number;
        currentLabel: string;
      }
  >({ phase: "idle" });

  // Keep draft synced when persisted schedule changes (e.g. on first load).
  useEffect(() => {
    setDraftSchedule(backupSchedule);
  }, [backupSchedule]);

  // When the user changes the tool selection (or destination), refresh the
  // on-disk script so the next scheduled run picks up the new selection
  // without requiring the user to click "Back up now" or re-install. Best-
  // effort — silent on error, since the toast for "no destination yet" is
  // already surfaced when the user tries to actually run a backup.
  useEffect(() => {
    if (!backupDestination) return;
    ensureLocalGenerated().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupTools, backupDataTypes, backupDestination, backupSchedule, platform]);

  async function probeStatus(): Promise<ScheduleStatus> {
    if (platform === "windows") {
      const s = await winGetStatus();
      // Map WinScheduleStatus into the shared ScheduleStatus shape so the
      // existing UI (status pill + label) renders identically to macOS.
      if (s.kind === "loaded") {
        return { kind: "loaded", pid: s.pid, lastExitCode: s.lastExitCode };
      }
      return { kind: s.kind };
    }
    if (platform === "linux") {
      const s = await linuxGetStatus();
      if (s.kind === "loaded") {
        // cron has no PID/last-exit telemetry — null both so the UI renders
        // "Status: registered" without a stale running indicator.
        return { kind: "loaded", pid: null, lastExitCode: null };
      }
      return { kind: s.kind };
    }
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

  // Refresh schedule status (launchd on macOS, Task Scheduler on Windows).
  // Re-runs when destination changes — paths derived from it.
  useEffect(() => {
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
      const paths = await resolvePlatformPaths();
      if (platform === "windows") {
        const result = await winDiagnose({
          scriptPath: paths.scriptPath,
          exists: (p) => tauriFs.exists(p),
        });
        setDiag(result);
        return;
      }
      if (platform === "linux") {
        const result = await linuxDiagnose({
          scriptPath: paths.scriptPath,
          exists: (p) => tauriFs.exists(p),
        });
        setDiag(result);
        return;
      }
      const result = await diagnoseSchedule({
        installedPlistPath: paths.installedPlistPath!,
        exists: (p) => tauriFs.exists(p),
        scriptPath: paths.scriptPath,
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
      const { logPath } = await resolvePlatformPaths();
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
    refreshLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  // Resolve every path the backup plumbing needs for the current platform in
  // one place, so handleBackup, ensureLocalGenerated, schedule install/
  // uninstall, and the log-tail/diagnose paths all stay aligned.
  //
  // macOS layout:
  //   outDir         = ~/Library/Application Support/skillsafe-app/scheduled-backup/
  //   logPath        = ~/Library/Logs/skillsafe-backup.log
  //   scriptPath     = <outDir>/claude_backup.sh
  //   restorePath    = <outDir>/claude_restore.sh
  //   sourcePlistPath = <outDir>/<SERVICE_LABEL>.plist  (read by install())
  //   installedPlistPath = ~/Library/LaunchAgents/<SERVICE_LABEL>.plist
  //
  // Windows layout (mirrors macOS conventions):
  //   outDir         = %LOCALAPPDATA%\skillsafe-app\scheduled-backup\
  //   logPath        = %LOCALAPPDATA%\skillsafe-app\Logs\skillsafe-backup.log
  //   scriptPath     = <outDir>\claude_backup.ps1
  //   restorePath    = <outDir>\claude_restore.ps1
  //   sourcePlistPath / installedPlistPath = null (Task Scheduler is registered
  //     by schtasks directly — no XML file the user manages).
  //
  // Linux layout (XDG):
  //   outDir         = ~/.local/share/skillsafe-app/scheduled-backup/
  //   logPath        = ~/.local/state/skillsafe-app/skillsafe-backup.log
  //   scriptPath     = <outDir>/claude_backup.sh
  //   restorePath    = <outDir>/claude_restore.sh
  //   cronStagePath  = <outDir>/.crontab.next  (temp file piped to crontab(1))
  //   sourcePlistPath / installedPlistPath = null (cron is line-based — no
  //     plist analogue).
  async function resolvePlatformPaths(): Promise<{
    outDir: string;
    logPath: string;
    scriptPath: string;
    restorePath: string;
    sourcePlistPath: string | null;
    installedPlistPath: string | null;
    cronStagePath: string | null;
  }> {
    const home = await tauriPaths.homeDir();
    if (platform === "windows") {
      const outDir = await tauriJoiner.join(
        home,
        "AppData",
        "Local",
        "skillsafe-app",
        "scheduled-backup",
      );
      const logDir = await tauriJoiner.join(
        home,
        "AppData",
        "Local",
        "skillsafe-app",
        "Logs",
      );
      const logPath = await tauriJoiner.join(logDir, "skillsafe-backup.log");
      return {
        outDir,
        logPath,
        scriptPath: await tauriJoiner.join(outDir, "claude_backup.ps1"),
        restorePath: await tauriJoiner.join(outDir, "claude_restore.ps1"),
        sourcePlistPath: null,
        installedPlistPath: null,
        cronStagePath: null,
      };
    }
    if (platform === "linux") {
      const outDir = await tauriJoiner.join(
        home,
        ".local",
        "share",
        "skillsafe-app",
        "scheduled-backup",
      );
      const logPath = await tauriJoiner.join(
        home,
        ".local",
        "state",
        "skillsafe-app",
        "skillsafe-backup.log",
      );
      return {
        outDir,
        logPath,
        scriptPath: await tauriJoiner.join(outDir, "claude_backup.sh"),
        restorePath: await tauriJoiner.join(outDir, "claude_restore.sh"),
        sourcePlistPath: null,
        installedPlistPath: null,
        cronStagePath: await tauriJoiner.join(outDir, ".crontab.next"),
      };
    }
    const outDir = await tauriJoiner.join(
      home,
      "Library",
      "Application Support",
      "skillsafe-app",
      "scheduled-backup",
    );
    const logPath = await tauriJoiner.join(home, "Library", "Logs", "skillsafe-backup.log");
    const installedPlistPath = await tauriJoiner.join(
      home,
      "Library",
      "LaunchAgents",
      `${SERVICE_LABEL}.plist`,
    );
    return {
      outDir,
      logPath,
      scriptPath: await tauriJoiner.join(outDir, "claude_backup.sh"),
      restorePath: await tauriJoiner.join(outDir, "claude_restore.sh"),
      sourcePlistPath: await tauriJoiner.join(outDir, `${SERVICE_LABEL}.plist`),
      installedPlistPath,
      cronStagePath: null,
    };
  }

  async function ensureLocalGenerated(
    schedule: ScheduleSpec = backupSchedule,
  ): Promise<{
    scriptPath: string;
    restorePath: string;
    sourcePlistPath: string | null;
    installedPlistPath: string | null;
    cronStagePath: string | null;
    outDir: string;
  }> {
    if (!backupDestination) throw new Error("Pick a destination folder first.");
    const home = await tauriPaths.homeDir();
    const paths = await resolvePlatformPaths();
    // Local copy lives outside OneDrive/Dropbox so the scheduler can read it
    // even when the cloud destination is offline or cloud-only-stub.
    await generateScripts({
      fs: tauriFs,
      joiner: tauriJoiner,
      platform,
      home,
      destination: backupDestination,
      outDir: paths.outDir,
      schedule,
      tools: backupTools,
      dataTypes: backupDataTypes,
    });
    if (platform === "linux") {
      // cron(1) requires the script to be executable. atomicWrite leaves the
      // mode at the filesystem default (typically 0644); chmod here so the
      // crontab line we install can actually run.
      try {
        await Command.create("bash", ["-c", `chmod +x "${paths.scriptPath}" "${paths.restorePath}"`]).execute();
      } catch {
        // Best-effort: chmod failures surface later as cron-job failures with
        // a clear "permission denied" in the log. Don't block install on it.
      }
    }
    return {
      scriptPath: paths.scriptPath,
      restorePath: paths.restorePath,
      sourcePlistPath: paths.sourcePlistPath,
      installedPlistPath: paths.installedPlistPath,
      cronStagePath: paths.cronStagePath,
      outDir: paths.outDir,
    };
  }

  async function handleScheduleInstall() {
    setScheduleBusy("install");
    try {
      const { scriptPath, sourcePlistPath, installedPlistPath, cronStagePath } =
        await ensureLocalGenerated();
      if (platform === "windows") {
        await winInstall({ scriptPath, schedule: backupSchedule });
        const status = await probeStatus();
        setScheduleStatus(status);
        onToast("ok", `Daily backup installed. ${scheduleSummary(backupSchedule)}`);
        return;
      }
      if (platform === "linux") {
        await linuxInstall({
          scriptPath,
          schedule: backupSchedule,
          stagePath: cronStagePath!,
          writeFile: (p, c) => tauriFs.writeTextFile(p, c),
          removeFile: (p) => tauriFs.remove(p),
        });
        const status = await probeStatus();
        setScheduleStatus(status);
        onToast("ok", `Daily backup installed. ${scheduleSummary(backupSchedule)}`);
        return;
      }
      // macOS: read the generated plist and bootstrap it via launchctl. The
      // local plist references a script outside OneDrive so the bootstrap
      // path validates even when the cloud destination is offline.
      const home = await tauriPaths.homeDir();
      const sourcePlistContents = await tauriFs.readTextFile(sourcePlistPath!);
      const launchAgentsDir = await tauriJoiner.join(home, "Library", "LaunchAgents");
      // Fresh macOS user accounts don't have ~/Library/LaunchAgents until
      // something installs into it. Create it ourselves so writeFile can land.
      await tauriFs.mkdir(launchAgentsDir, { recursive: true });
      await installSchedule({
        sourcePlistContents,
        installedPlistPath: installedPlistPath!,
        writeFile: (p, c) => tauriFs.writeTextFile(p, c),
      });
      const status = await probeStatus();
      setScheduleStatus(status);
      onToast("ok", `Daily backup installed. ${scheduleSummary(backupSchedule)}`);
    } catch (e) {
      onToast("error", `Install failed: ${describeErr(e)}`);
    } finally {
      setScheduleBusy(null);
    }
  }

  async function handleScheduleUninstall() {
    setScheduleBusy("uninstall");
    try {
      if (platform === "windows") {
        await winUninstall();
        const status = await probeStatus();
        setScheduleStatus(status);
        onToast("ok", "Daily backup uninstalled.");
        return;
      }
      if (platform === "linux") {
        const paths = await resolvePlatformPaths();
        await linuxUninstall({
          stagePath: paths.cronStagePath!,
          writeFile: (p, c) => tauriFs.writeTextFile(p, c),
          removeFile: (p) => tauriFs.remove(p),
        });
        const status = await probeStatus();
        setScheduleStatus(status);
        onToast("ok", "Daily backup uninstalled.");
        return;
      }
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
      if (platform === "windows") {
        await winRunNow();
      } else if (platform === "linux") {
        const { scriptPath } = await ensureLocalGenerated();
        await linuxRunNow(scriptPath);
      } else {
        await runScheduleNow();
      }
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
    // Already installed — re-install with the new schedule.
    setScheduleBusy("install");
    try {
      const { scriptPath, sourcePlistPath, installedPlistPath, cronStagePath } =
        await ensureLocalGenerated(draftSchedule);
      if (platform === "windows") {
        await winInstall({ scriptPath, schedule: draftSchedule });
      } else if (platform === "linux") {
        await linuxInstall({
          scriptPath,
          schedule: draftSchedule,
          stagePath: cronStagePath!,
          writeFile: (p, c) => tauriFs.writeTextFile(p, c),
          removeFile: (p) => tauriFs.remove(p),
        });
      } else {
        const home = await tauriPaths.homeDir();
        const sourcePlistContents = await tauriFs.readTextFile(sourcePlistPath!);
        const launchAgentsDir = await tauriJoiner.join(home, "Library", "LaunchAgents");
        await tauriFs.mkdir(launchAgentsDir, { recursive: true });
        await installSchedule({
          sourcePlistContents,
          installedPlistPath: installedPlistPath!,
          writeFile: (p, c) => tauriFs.writeTextFile(p, c),
        });
      }
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
    const target = backupStats?.backupRoot ?? backupDestination;
    if (!target) {
      onToast("error", "Pick a destination folder first.");
      return;
    }
    try {
      await shellOpen(target);
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
      // and schedule. Then exec the same script the OS scheduler would have
      // run, so manual + scheduled paths share one implementation.
      const { scriptPath } = await ensureLocalGenerated();
      const out =
        platform === "windows"
          ? await Command.create("powershell", [
              "-WindowStyle",
              "Hidden",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              scriptPath,
            ]).execute()
          : await Command.create("bash", [scriptPath]).execute();
      // Script exit codes: 0 = clean, 2 = ran with non-fatal failures (logged),
      // anything else = fatal (e.g. destination missing).
      if (out.code !== 0 && out.code !== 2) {
        throw new Error(out.stderr || out.stdout || `exit code ${out.code}`);
      }
      const generatedAt = Date.now();
      // Aggregate per-tool LAST_BACKUP.json manifests into the stats line
      // ("Last backup: …+N ~M -K · X MB"). The old whole-destination walker
      // (summary.ts) wrote a duplicate root-level manifest that ingested the
      // master/ folder, producing stale rows in the BackupBrowser; per-tool
      // manifests already track adds/changes/removes scoped to their tool.
      try {
        const merged = await aggregateToolManifests(
          tauriFs,
          tauriJoiner,
          backupDestination,
        );
        if (merged) {
          // Override with the run's actual timestamp so "Last backup: just
          // now" stays accurate even if individual tool manifests were
          // stamped slightly earlier.
          merged.generatedAt = generatedAt;
          merged.destination = backupDestination;
          setBackupResult(generatedAt, summarize(merged));
        } else {
          setBackupResult(generatedAt, {
            generatedAt,
            counts: { added: 0, changed: 0, removed: 0, unchanged: 0 },
            totalBytes: 0,
            errorCount: 0,
            errorSamples: [],
            recentChanges: [],
            backupRoot: backupDestination,
          });
        }
      } catch {
        // Stats are observability — never fail a backup over them.
        setBackupResult(generatedAt, {
          generatedAt,
          counts: { added: 0, changed: 0, removed: 0, unchanged: 0 },
          totalBytes: 0,
          errorCount: 0,
          errorSamples: [],
          recentChanges: [],
          backupRoot: backupDestination,
        });
      }
      // One-time cleanup: older versions wrote a top-level
      // <dest>/LAST_BACKUP.json that's now obsolete. Delete it so the
      // BackupBrowser doesn't keep finding stale entries (and we don't
      // need a legacy-fallback code path). Best-effort.
      try {
        const stalePath = await tauriJoiner.join(
          backupDestination,
          MANIFEST_FILENAME,
        );
        if (await tauriFs.exists(stalePath)) {
          await tauriFs.remove(stalePath);
        }
      } catch {
        /* best-effort */
      }
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

  async function handleRestoreScan(mirror: boolean) {
    if (!backupDestination) {
      onToast("error", "Pick a destination folder first.");
      return;
    }
    setRestoreState({ phase: "scanning", mirror });
    try {
      const home = await tauriPaths.homeDir();
      const mappings = await resolveRestoreMappings({
        fs: tauriFs,
        joiner: tauriJoiner,
        home,
        destination: backupDestination,
        tools: backupTools,
        dataTypes: backupDataTypes,
      });
      const conflicts = await scanForConflicts({
        fs: tauriFs,
        joiner: tauriJoiner,
        mappings,
        mirror,
      });
      if (conflicts.length === 0) {
        setRestoreState({ phase: "idle" });
        onToast("ok", "Live tree already matches the backup. Nothing to restore.");
        return;
      }
      // Default-select every conflict — the user starts from "restore
      // everything" and unchecks anything they want to keep.
      const selected = new Set(conflicts.map((c) => c.id));
      setRestoreState({ phase: "preview", conflicts, selected, mirror });
    } catch (e) {
      setRestoreState({ phase: "idle" });
      onToast("error", `Restore scan failed: ${describeErr(e)}`);
    }
  }

  async function handleRestoreApply(items: ConflictItem[]) {
    if (items.length === 0) {
      onToast("error", "No files selected.");
      return;
    }
    setRestoreState({
      phase: "applying",
      total: items.length,
      done: 0,
      currentLabel: items[0].rel,
    });
    try {
      const result = await applyRestore({
        fs: tauriFs,
        items,
        onProgress: (done, total, current) => {
          setRestoreState({
            phase: "applying",
            total,
            done,
            currentLabel: current.rel,
          });
        },
      });
      if (result.failed.length > 0) {
        const sample = result.failed
          .slice(0, 3)
          .map((f) => `${f.item.rel}: ${f.error}`)
          .join("\n");
        onToast(
          "error",
          `Restored ${result.copied} file${result.copied === 1 ? "" : "s"}` +
            ` (${result.deleted} deleted), ${result.failed.length} failed.\n\n${sample}`,
        );
      } else {
        onToast(
          "ok",
          `Restored ${result.copied} file${result.copied === 1 ? "" : "s"}` +
            (result.deleted > 0 ? ` (${result.deleted} deleted)` : ""),
        );
      }
    } catch (e) {
      onToast("error", `Restore failed: ${describeErr(e)}`);
    } finally {
      setRestoreState({ phase: "idle" });
    }
  }

  function toggleConflictSelection(id: string) {
    if (restoreState.phase !== "preview") return;
    const next = new Set(restoreState.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setRestoreState({ ...restoreState, selected: next });
  }

  function toggleSection(sectionLabel: string, on: boolean) {
    if (restoreState.phase !== "preview") return;
    const next = new Set(restoreState.selected);
    for (const c of restoreState.conflicts) {
      if (c.section !== sectionLabel) continue;
      if (on) next.add(c.id);
      else next.delete(c.id);
    }
    setRestoreState({ ...restoreState, selected: next });
  }

  function toggleAllConflicts(on: boolean) {
    if (restoreState.phase !== "preview") return;
    const next = on
      ? new Set(restoreState.conflicts.map((c) => c.id))
      : new Set<string>();
    setRestoreState({ ...restoreState, selected: next });
  }

  async function handleGenerateScript() {
    if (!backupDestination) {
      onToast("error", "Pick a destination folder first.");
      return;
    }
    setGenerating(true);
    try {
      const home = await tauriPaths.homeDir();
      // Generate the script + scheduler config under our per-platform app-data
      // dir, never inside the user's cloud-synced backup folder. Cloud daemons
      // (OneDrive, Dropbox) introduce permission and sync-lock issues for
      // executable scripts, and putting the runner inside the folder it
      // writes to creates needless coupling. The script still mirrors TO the
      // user's chosen destination at runtime.
      const { outDir } = await resolvePlatformPaths();
      const result = await generateScripts({
        fs: tauriFs,
        joiner: tauriJoiner,
        platform,
        home,
        destination: backupDestination,
        outDir,
        tools: backupTools,
        dataTypes: backupDataTypes,
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

      <BackupToolsPicker
        tools={ALL_TOOLS}
        selected={backupTools}
        dataTypeSelection={backupDataTypes}
        onToggleTool={toggleTool}
        onToggleDataType={(tool, id, on) => {
          const cur = backupDataTypes[tool] ?? [];
          const next = on ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id);
          setBackupDataTypes(tool, next);
        }}
      />
      <div className="backup-symlink-note">
        Symlinks pointing outside the source tree (for example, a Claude skill
        linked to <code>.agents/skills/</code>) are dereferenced into the
        backup so the linked content travels with the backup.
      </div>

      <div className="settings-row" style={{ flexWrap: "wrap" }}>
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
        <button
          onClick={() => handleRestoreScan(false)}
          disabled={
            !backupDestination ||
            backupBusy ||
            restoreState.phase === "scanning" ||
            restoreState.phase === "applying"
          }
          title={
            !backupDestination
              ? "Pick a backup folder above"
              : "Scan the backup against your live tree; warns before overwriting anything"
          }
        >
          {restoreState.phase === "scanning"
            ? "Scanning…"
            : restoreState.phase === "applying"
              ? "Restoring…"
              : "Restore from backup…"}
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
            disabled={!!scheduleBusy}
            title={
              platform === "windows"
                ? "Refresh Task Scheduler status"
                : "Refresh launchd status"
            }
          >
            {scheduleBusy === "refresh" ? "Checking…" : "Refresh"}
          </button>
          <button
            className="link-btn"
            onClick={runDiagnose}
            title="Run all status probes and dump raw output for debugging"
          >
            Diagnose
          </button>
        </div>
      </div>
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
              {scheduleStatusLabel(scheduleStatus, platform)}
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
              ) : scheduleStatus.kind === "unsupported" ? (
                // No scheduler binary on this system (cron missing on Linux,
                // launchctl missing/sandboxed on macOS, schtasks missing on
                // Windows). Hide the install action — clicking it just
                // bubbles up an ENOENT spawn error. Surface guidance instead.
                <span
                  className="projects-summary-text"
                  style={{ fontSize: 11, color: "var(--muted)" }}
                  title={
                    platform === "windows"
                      ? "Task Scheduler (schtasks.exe) was not found on this system."
                      : platform === "linux"
                        ? "cron(1) was not found. Install your distro's cron package (e.g. cronie, vixie-cron) and reopen this dialog."
                        : "launchctl was not found. This is unusual on macOS — try restarting the app."
                  }
                >
                  Scheduler unavailable
                </span>
              ) : (
                <button
                  className="primary"
                  onClick={handleScheduleInstall}
                  disabled={!!scheduleBusy || !backupDestination}
                  title={
                    !backupDestination
                      ? "Pick a destination first"
                      : platform === "windows"
                        ? "Register a Task Scheduler job that runs the backup on the schedule below"
                        : platform === "linux"
                          ? "Add a cron entry that runs the backup on the schedule below"
                          : "Install a launchd job that runs the backup on the schedule below"
                  }
                >
                  {scheduleBusy === "install" ? "Installing…" : "Install daily backup"}
                </button>
              )}
            </div>
          </div>
          <div className="projects-summary-text" style={{ fontSize: 11, paddingLeft: 6 }}>
            {platform === "windows"
              ? "Task"
              : platform === "linux"
              ? "Cron job"
              : "Service"}:{" "}
            <code>{platform === "windows" ? WIN_TASK_NAME : SERVICE_LABEL}</code> ·{" "}
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
                      const { logPath } = await resolvePlatformPaths();
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
              No log yet. Once the schedule has run at least once,{" "}
              {platform === "windows"
                ? "%LOCALAPPDATA%\\skillsafe-app\\Logs\\skillsafe-backup.log"
                : "~/Library/Logs/skillsafe-backup.log"}{" "}
              will show its output here.
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

      {restoreState.phase === "preview" && (
        <RestorePreviewDialog
          conflicts={restoreState.conflicts}
          selected={restoreState.selected}
          mirror={restoreState.mirror}
          backupDestination={backupDestination ?? ""}
          onToggle={toggleConflictSelection}
          onToggleSection={toggleSection}
          onToggleAll={toggleAllConflicts}
          onCancel={() => setRestoreState({ phase: "idle" })}
          onConfirm={() =>
            handleRestoreApply(
              restoreState.conflicts.filter((c) => restoreState.selected.has(c.id)),
            )
          }
        />
      )}

      {restoreState.phase === "applying" && (
        <div className="dialog-backdrop">
          <div className="dialog" style={{ maxWidth: 420 }}>
            <header className="settings-header">
              <h3>Restoring…</h3>
            </header>
            <div className="settings-body">
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                {restoreState.done} / {restoreState.total} files
              </div>
              <div className="dl-progress" role="status" aria-live="polite" style={{ marginTop: 8 }}>
                <div className="dl-progress-bar">
                  <div
                    className="dl-progress-fill"
                    style={{
                      width:
                        restoreState.total > 0
                          ? `${Math.min(100, Math.round((restoreState.done / restoreState.total) * 100))}%`
                          : "0%",
                    }}
                  />
                </div>
                <div className="dl-progress-label" style={{ marginTop: 6 }}>
                  {restoreState.currentLabel}
                </div>
              </div>
            </div>
          </div>
        </div>
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
                The{" "}
                {platform === "windows"
                  ? "Task Scheduler task"
                  : platform === "linux"
                  ? "cron entry"
                  : "launchd job"}{" "}
                <code>{platform === "windows" ? WIN_TASK_NAME : SERVICE_LABEL}</code>{" "}
                will be stopped and removed. Your backup folder and existing
                files are not deleted.
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

function scheduleStatusLabel(s: ScheduleStatus, platform: BackupPlatform): string {
  if (s.kind === "not_installed") return "Not installed";
  if (s.kind === "unsupported") {
    if (platform === "windows") return "Task Scheduler not available on this system";
    if (platform === "linux") return "cron not available on this system";
    return "launchd not available on this system";
  }
  if (s.kind === "installed_not_loaded") return "Installed · launchd hasn't picked it up yet";
  // loaded — pid is a Windows running-flag sentinel (1) or the real macOS PID
  if (s.pid !== null && s.pid > 0) {
    return platform === "windows" ? "Running" : `Running (PID ${s.pid})`;
  }
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

function formatDiagnostics(
  d: DiagnosticResult | WinDiagnosticResult | LinuxDiagnosticResult,
): string {
  if (isWinDiagnostic(d)) return formatWinDiagnostics(d);
  if (isLinuxDiagnostic(d)) return formatLinuxDiagnostics(d);
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

function isWinDiagnostic(
  d: DiagnosticResult | WinDiagnosticResult | LinuxDiagnosticResult,
): d is WinDiagnosticResult {
  return (d as WinDiagnosticResult).taskName !== undefined;
}

function isLinuxDiagnostic(
  d: DiagnosticResult | WinDiagnosticResult | LinuxDiagnosticResult,
): d is LinuxDiagnosticResult {
  return (d as LinuxDiagnosticResult).cronAvailable !== undefined;
}

function formatWinDiagnostics(d: WinDiagnosticResult): string {
  return [
    `task: ${d.taskName}`,
    `script path: ${d.scriptPath ?? "(unknown)"}`,
    `script exists: ${d.scriptExists ?? "(unchecked)"}`,
    "",
    `# schtasks /Query /TN ${d.taskName} /FO LIST /V  (exit ${d.queryCode})`,
    d.queryOutput || "(no output)",
  ].join("\n");
}

function formatLinuxDiagnostics(d: LinuxDiagnosticResult): string {
  return [
    `cron available: ${d.cronAvailable}`,
    `cron has our line: ${d.cronHasOurLine}`,
    `cron line: ${d.cronLine ?? "(none)"}`,
    `script path: ${d.scriptPath ?? "(unknown)"}`,
    `script exists: ${d.scriptExists ?? "(unchecked)"}`,
    "",
    `# crontab -l  (exit ${d.crontabReadCode})`,
    d.crontabReadOutput || "(no output)",
    "",
    `# our cron marker: ${LINUX_CRON_MARKER}`,
  ].join("\n");
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
  // Trust @tauri-apps/plugin-os when it answers, but never silently fall
  // through to "macos" — on Linux the Tauri webview occasionally reports
  // an unexpected value or the invoke throws before the plugin is wired
  // up, and the macOS default would route the install handler into
  // launchctl, which spawns to ENOENT ("No such file or directory (os
  // error 2)") on Linux. Cross-check with navigator.userAgent/platform
  // so we land on the correct branch even when osType() is unhappy.
  try {
    const t = osType();
    if (t === "windows" || t === "linux" || t === "macos") return t;
  } catch {
    /* fall through to UA-based detection */
  }
  const ua = (typeof navigator !== "undefined"
    ? `${navigator.userAgent || ""} ${navigator.platform || ""}`
    : ""
  ).toLowerCase();
  if (/windows|win32|win64/.test(ua)) return "windows";
  if (/linux|x11|cros/.test(ua)) return "linux";
  return "macos";
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

interface RestorePreviewDialogProps {
  conflicts: ConflictItem[];
  selected: Set<string>;
  mirror: boolean;
  backupDestination: string;
  onToggle: (id: string) => void;
  onToggleSection: (sectionLabel: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

// Lists conflicts grouped by section, with a checkbox per file and a master
// "select all" / per-section toggle. Distinct from ConfirmDialog because the
// scrollable file list is the whole point.
function RestorePreviewDialog({
  conflicts,
  selected,
  mirror,
  backupDestination,
  onToggle,
  onToggleSection,
  onToggleAll,
  onCancel,
  onConfirm,
}: RestorePreviewDialogProps) {
  const grouped = useMemo(() => {
    const map = new Map<string, ConflictItem[]>();
    for (const c of conflicts) {
      const arr = map.get(c.section) ?? [];
      arr.push(c);
      map.set(c.section, arr);
    }
    return Array.from(map.entries());
  }, [conflicts]);
  const selCount = selected.size;
  const total = conflicts.length;
  const allOn = selCount === total;
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog restore-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h3>Review restore — {total} conflict{total === 1 ? "" : "s"}</h3>
          <button
            className="settings-close icon-btn"
            aria-label="Cancel restore"
            onClick={onCancel}
          >
            ×
          </button>
        </header>
        <div className="settings-body">
          <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
            From <code>{backupDestination}</code>. Uncheck any file you want to
            keep as-is — only checked files will be overwritten in your live
            tree.
            {mirror && " Mirror mode: 'extra' files in your live tree (missing from the backup) will be deleted if checked."}
          </div>
          <div className="restore-toolbar">
            <span className="restore-count">
              {selCount} of {total} selected
            </span>
            <button className="link-btn" onClick={() => onToggleAll(true)} disabled={allOn}>
              Select all
            </button>
            <button className="link-btn" onClick={() => onToggleAll(false)} disabled={selCount === 0}>
              Deselect all
            </button>
          </div>
          <ul className="restore-section-list">
            {grouped.map(([section, items]) => {
              const onCount = items.filter((i) => selected.has(i.id)).length;
              const all = onCount === items.length;
              const indeterminate = onCount > 0 && onCount < items.length;
              return (
                <li key={section} className="restore-section">
                  <label className="restore-section-head">
                    <input
                      type="checkbox"
                      checked={all}
                      ref={(el) => {
                        if (el) el.indeterminate = indeterminate;
                      }}
                      onChange={(e) => onToggleSection(section, e.target.checked)}
                    />
                    <span className="restore-section-name">{section}</span>
                    <span className="restore-section-count">
                      {onCount}/{items.length}
                    </span>
                  </label>
                  <ul className="restore-file-list">
                    {items.map((c) => (
                      <li key={c.id} className="restore-file-row">
                        <label className="restore-file-label">
                          <input
                            type="checkbox"
                            checked={selected.has(c.id)}
                            onChange={() => onToggle(c.id)}
                          />
                          <span className={`restore-kind kind-${c.kind}`}>
                            {c.kind === "new"
                              ? "new"
                              : c.kind === "modified"
                                ? "modify"
                                : "delete"}
                          </span>
                          <span className="restore-rel" title={c.dstPath}>
                            {c.rel}
                          </span>
                          <span className="restore-size">
                            {c.kind === "extra"
                              ? formatBytes(c.dstSize ?? 0)
                              : c.kind === "modified" && c.dstSize !== null
                                ? `${formatBytes(c.dstSize)} → ${formatBytes(c.srcSize ?? 0)}`
                                : formatBytes(c.srcSize ?? 0)}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
        <footer className="restore-footer">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary danger" onClick={onConfirm} disabled={selCount === 0}>
            Restore {selCount} file{selCount === 1 ? "" : "s"}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface BackupToolsPickerProps {
  tools: ReadonlyArray<{ id: Tool; label: string; tooltip?: string }>;
  selected: readonly Tool[];
  dataTypeSelection: Record<Tool, string[]>;
  onToggleTool: (tool: Tool) => void;
  onToggleDataType: (tool: Tool, id: string, on: boolean) => void;
}

// Tool list with per-tool data-type checkboxes. Enabled tools that have a
// known sub-structure (Claude, Codex, …) expand inline so the user can pick
// which slices of the tool's config to back up. Tools with only the fallback
// "all" data type render as a simple checkbox.
function BackupToolsPicker({
  tools,
  selected,
  dataTypeSelection,
  onToggleTool,
  onToggleDataType,
}: BackupToolsPickerProps) {
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<Tool>>(new Set());
  const toggleCollapsed = (id: Tool) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const lc = filter.trim().toLowerCase();
  const visible = lc
    ? tools.filter((t) => t.id.toLowerCase().includes(lc) || t.label.toLowerCase().includes(lc))
    : showAll
      ? tools
      : tools.filter((t) => selected.includes(t.id));
  const enabledCount = selected.length;
  return (
    <div className="backup-tools-picker">
      <div className="settings-section-title-row">
        <div className="settings-section-title" style={{ fontSize: 12 }}>
          Tools &amp; data types ({enabledCount} selected)
        </div>
        <input
          type="search"
          className="backup-tools-filter"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter tools"
        />
      </div>
      {visible.length === 0 ? (
        <div className="projects-empty" style={{ fontSize: 11 }}>
          {lc ? "No tools match the filter." : "No tools selected yet."}
        </div>
      ) : (
        <ul className="backup-tools-list">
          {visible.map((t) => {
            const enabled = selected.includes(t.id);
            const types = dataTypesFor(t.id);
            const flat = types.length === 1 && types[0].id === "all";
            const ids = dataTypeSelection[t.id] ?? [];
            const expanded = enabled && !flat && !collapsed.has(t.id);
            return (
              <li
                key={t.id}
                className={`backup-tool-card ${enabled ? "active" : ""}`}
                title={t.tooltip}
              >
                <div className="backup-tool-card-head">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => onToggleTool(t.id)}
                    aria-label={`Select ${t.label}`}
                  />
                  <button
                    type="button"
                    className="backup-tool-card-nametoggle"
                    onClick={() => {
                      if (!flat && enabled) toggleCollapsed(t.id);
                      else onToggleTool(t.id);
                    }}
                    aria-expanded={!flat ? expanded : undefined}
                    title={t.tooltip}
                  >
                    <span className="backup-tool-card-name">{t.label}</span>
                    <span className="backup-tool-card-meta">
                      {flat
                        ? "all config files"
                        : enabled
                          ? `${ids.length}/${types.length} data types`
                          : `${types.length} data types`}
                    </span>
                  </button>
                </div>
                {expanded && (
                  <ul className="backup-data-type-list">
                    {types.map((dt) => {
                      const on = ids.includes(dt.id);
                      return (
                        <li key={dt.id} className="backup-data-type-row">
                          <label className="backup-data-type-label">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={(e) => onToggleDataType(t.id, dt.id, e.target.checked)}
                            />
                            <span className="backup-data-type-name">{dt.label}</span>
                          </label>
                          {dt.description && (
                            <div className="backup-data-type-desc">{dt.description}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!lc && (
        <button
          type="button"
          className="link-btn backup-tools-toggle"
          onClick={() => setShowAll((s) => !s)}
        >
          {showAll ? "Hide unselected tools" : `Show all ${tools.length} tools…`}
        </button>
      )}
    </div>
  );
}

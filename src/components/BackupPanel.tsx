import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { buildAndWriteManifest } from "../lib/backup/summary";
import {
  manifestPath as manifestPathOf,
  sentinelPath as sentinelPathOf,
  parseSentinel,
  detectPlatform,
} from "../lib/backup/appPaths";
import { detectLogIssues, type BackupLogIssue } from "../lib/backup/logIssues";
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
import { isTauriRuntime } from "../lib/runtime";
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

// camelCase a data-type id for `categories.*` i18n key lookup. Mirrors the
// helpers in Sidebar.tsx / CategoryBrowser.tsx so the same translation key
// resolves for the same dt.id regardless of which surface renders it.
function dataTypeI18nKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

interface Props {
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function BackupPanel({ onToast }: Props) {
  const { t } = useTranslation();
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

  function toggleTool(tool: Tool) {
    if (backupTools.includes(tool)) {
      const next = backupTools.filter((x) => x !== tool);
      // Allow zero tools — the script will no-op and log "nothing to back up".
      setBackupTools(next);
    } else {
      setBackupTools([...backupTools, tool]);
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
  // When the log auto-grows during a backup, keep the latest line in view
  // without forcing the user to scroll. We snap to the bottom on every log
  // refresh while `backupBusy` is true; once the run ends the user can
  // scroll freely without us yanking it back.
  const logPreRef = useRef<HTMLPreElement>(null);
  // Guards the 250ms minimum-on delay in handleBackup's finally — without it,
  // a panel unmount mid-delay would trigger a setState-on-unmounted warning.
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);
  const [showFixSteps, setShowFixSteps] = useState(false);
  const logIssues: BackupLogIssue[] = useMemo(
    () => (logTail?.text ? detectLogIssues(logTail.text) : []),
    [logTail?.text],
  );
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
      onToast("error", t("backupPanel.errors.diagnoseFailed", { message: describeErr(e) }));
    }
  }

  async function refreshSchedule() {
    setScheduleBusy("refresh");
    try {
      const status = await probeStatus();
      setScheduleStatus(status);
      await refreshLog();
    } catch (e) {
      onToast("error", t("backupPanel.errors.statusCheckFailed", { message: describeErr(e) }));
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
    // Sentinel-driven refresh: every successful backup run (manual via this
    // panel, "Run now", or the scheduled fire at 3 am) drops a sentinel with
    // started_at / finished_at / exit_code into the app state dir. If it's
    // newer than the manifest currently summarised in `backupStats`, walk
    // the destination again so the "Recent changes" list reflects the run
    // we just observed. Skipped when no destination is set or when a manual
    // backup is already in progress (the in-flight handler will refresh).
    if (!backupDestination || backupBusy) return;
    try {
      const home = await tauriPaths.homeDir();
      const sPath = await sentinelPathOf(platform, home, tauriJoiner);
      if (!(await tauriFs.exists(sPath))) return;
      const sentinelText = await tauriFs.readTextFile(sPath);
      const sentinel = parseSentinel(sentinelText);
      if (!sentinel) return;
      // sentinel.finishedAt is unix seconds; backupLastRun is unix
      // milliseconds (Date.now()). Normalize before comparing.
      const sentinelMs = sentinel.finishedAt * 1000;
      const knownDestinationOk =
        !!backupStats && backupStats.backupRoot === backupDestination;
      if (knownDestinationOk && backupLastRun && sentinelMs <= backupLastRun) return;
      const mPath = await manifestPathOf(platform, home, tauriJoiner);
      const { stats } = await buildAndWriteManifest({
        fs: tauriFs,
        joiner: tauriJoiner,
        destination: backupDestination,
        manifestPath: mPath,
        generatedAt: sentinelMs || Date.now(),
      });
      setBackupResult(stats.generatedAt, stats);
    } catch {
      // Sentinel refresh is observability only — never propagate a failure
      // here; the user still has the manual "Back up now" path.
    }
  }

  // Load log tail on mount, on platform change, and whenever the user
  // switches backup destinations — the sentinel-driven refresh inside
  // refreshLog needs to compare the manifest's recorded destination against
  // the current one, so a stale closure would miss the dest-change case.
  useEffect(() => {
    refreshLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, backupDestination]);

  // Auto-expand the log section the moment a run kicks off — manual or
  // schedule-triggered. Users don't need to find the "Show" button to see
  // what's happening; it's already open by the time the first line arrives.
  // The toggle is sticky after the run finishes so the user can read the
  // result; collapsing it manually still works.
  useEffect(() => {
    if (backupBusy || scheduleBusy === "run") {
      setShowLog(true);
    }
  }, [backupBusy, scheduleBusy]);

  // Poll the log every 1.2 s while a backup is running so the in-panel log
  // tail tracks the script's live output. Without this the user would see a
  // stale snapshot until the script exits and `handleBackup`'s post-run
  // refreshLog() fires. 1.2 s matches the indeterminate progress-bar
  // cadence so the two feel visually linked.
  useEffect(() => {
    if (!backupBusy && scheduleBusy !== "run") return;
    const id = setInterval(() => {
      refreshLog();
    }, 1200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupBusy, scheduleBusy]);

  // Keep the log pinned to the latest line while a run is active so the
  // user always sees the freshest output (matches the "tail -f" mental
  // model). After the run we leave the scroll position alone so the user
  // can scroll back to review.
  useEffect(() => {
    if (!backupBusy && scheduleBusy !== "run") return;
    const el = logPreRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logTail, backupBusy, scheduleBusy]);

  // Most-recent script line, used as the live progress label so the user
  // sees the actual rsync/robocopy section the script is currently working
  // through (e.g. "Sync claude · skills (8/14)") instead of just the static
  // "Starting backup…" phase that BackupPanel sets pre-spawn. Returns an
  // empty string when nothing useful is available so callers can fall back
  // to backupProgress.phase.
  function latestLogLine(): string {
    const text = logTail?.text;
    if (!text) return "";
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      // Drop the leading "[YYYY-MM-DD HH:MM:SS] " timestamp — the panel
      // already shows a relative "Running…" indicator so the wall-clock
      // stamp is just noise on a single-line preview.
      const stripped = line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/, "");
      return stripped;
    }
    return "";
  }

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
    if (!backupDestination) throw new Error(t("backupPanel.errors.pickDestination"));
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
        onToast("ok", t("backupPanel.ok.scheduleInstalled", { summary: scheduleSummary(backupSchedule, t) }));
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
        onToast("ok", t("backupPanel.ok.scheduleInstalled", { summary: scheduleSummary(backupSchedule, t) }));
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
      onToast("ok", t("backupPanel.ok.scheduleInstalled", { summary: scheduleSummary(backupSchedule, t) }));
    } catch (e) {
      onToast("error", t("backupPanel.errors.installFailed", { message: describeErr(e) }));
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
        onToast("ok", t("backupPanel.ok.scheduleUninstalled"));
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
        onToast("ok", t("backupPanel.ok.scheduleUninstalled"));
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
        onToast("ok", t("backupPanel.ok.scheduleUninstalled"));
      } else {
        onToast(
          "error",
          t("backupPanel.errors.manualUninstall", {
            command: result.manualCommand,
            reason: result.reason ?? t("backupPanel.errors.operationNotPermitted"),
          }),
        );
      }
    } catch (e) {
      onToast("error", t("backupPanel.errors.uninstallFailed", { message: describeErr(e) }));
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
      onToast("ok", t("backupPanel.ok.scheduleTriggered"));
      // Re-poll status after a short delay so the user sees the running PID.
      setTimeout(() => {
        probeStatus().then(setScheduleStatus).catch(() => {});
      }, 400);
      // Refresh the log shortly after — the script logs an opening line at
      // the top of every run so the user sees activity even before files copy.
      setTimeout(() => { refreshLog(); }, 1500);
    } catch (e) {
      onToast("error", t("backupPanel.errors.runFailed", { message: describeErr(e) }));
    } finally {
      setScheduleBusy(null);
    }
  }

  async function handleApplySchedule() {
    if (!isValidSchedule(draftSchedule)) {
      onToast("error", t("backupPanel.errors.invalidTime"));
      return;
    }
    setBackupSchedule(draftSchedule);
    if (scheduleStatus.kind !== "loaded") {
      onToast("ok", t("backupPanel.ok.scheduleSaved"));
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
      onToast("ok", t("backupPanel.ok.scheduleUpdated"));
    } catch (e) {
      onToast("error", t("backupPanel.errors.scheduleUpdateFailed", { message: describeErr(e) }));
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
      onToast("error", t("backupPanel.errors.pickDestination"));
      return;
    }
    try {
      await shellOpen(target);
    } catch (e) {
      onToast("error", t("backupPanel.errors.openFailed", { message: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function openEntry(destPath: string) {
    try {
      await shellOpen(destPath);
    } catch (e) {
      onToast("error", t("backupPanel.errors.openFailed", { message: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function pickDestination() {
    if (!isTauriRuntime()) {
      onToast("error", t("app.desktopRuntimeUnavailable"));
      return;
    }
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") setBackupDestination(picked);
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : String(e));
    }
  }

  async function handleBackup() {
    if (!backupDestination) {
      onToast("error", t("backupPanel.errors.pickDestination"));
      return;
    }
    // Minimum-on duration: keep backupBusy=true for at least 250ms even on
    // tiny diffs, so the "Backing up…" label is observable. Tracked from
    // the moment we flip the flag, not from picking destination.
    const busyStart = Date.now();
    setBackupBusy(true);
    setBackupProgress({
      phase: t("backupPanel.phase.starting"),
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
      // Spawn instead of execute so we can stream stdout into the live
      // progress label. The script's log() / Write-Log helpers emit
      // "[N/M] Sync <tool> · <category> ..." lines per section, so we can
      // surface meaningful per-step status instead of leaving the user
      // staring at "scanned 0 · copied 0" for the whole run.
      const out = await runScriptStreaming(scriptPath, (phase) => {
        setBackupProgress({
          phase,
          filesProcessed: 0,
          filesCopied: 0,
          bytesProcessed: 0,
          bytesCopied: 0,
        });
      });
      // Script exit codes: 0 = clean, 2 = ran with non-fatal failures (logged),
      // anything else = fatal (e.g. destination missing).
      if (out.code !== 0 && out.code !== 2) {
        throw new Error(out.stderr || out.stdout || `exit code ${out.code}`);
      }
      // Manifest walk can take several seconds on large backups; show its
      // own phase so the bar isn't visually "stuck" on the last script
      // line after the script exits.
      setBackupProgress({
        phase: t("backupPanel.phase.writingManifest"),
        filesProcessed: 0,
        filesCopied: 0,
        bytesProcessed: 0,
        bytesCopied: 0,
      });
      const generatedAt = Date.now();
      // Walk the destination, diff against the previous manifest, and write
      // an updated LAST_BACKUP.json. This now lands in the per-machine
      // app-state dir (see appPaths.manifestPath) rather than alongside the
      // backed-up files, so each machine maintains its own view and the
      // shared cloud-synced backup folder stays uncluttered. The walker in
      // summary.ts skips the master/ tree, so master files only ever
      // surface via loadMasterAsBackupEntries (live walk).
      try {
        const home = await tauriPaths.homeDir();
        const mPath = await manifestPathOf(platform, home, tauriJoiner);
        const { stats } = await buildAndWriteManifest({
          fs: tauriFs,
          joiner: tauriJoiner,
          destination: backupDestination,
          manifestPath: mPath,
          generatedAt,
        });
        setBackupResult(generatedAt, stats);
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
      refreshLog();
      if (out.code === 2) {
        onToast("error", t("backupPanel.errors.backupCompletedWithErrors"));
      } else {
        onToast("ok", t("backupPanel.ok.backupComplete"));
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      onToast("error", t("backupPanel.errors.backupFailed", { message: friendlyBackupError(raw, t) }));
    } finally {
      const remaining = 250 - (Date.now() - busyStart);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      if (isMountedRef.current) {
        setBackupBusy(false);
        setBackupProgress(null);
      }
    }
  }

  async function handleRestoreScan(mirror: boolean) {
    if (!backupDestination) {
      onToast("error", t("backupPanel.errors.pickDestination"));
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
        onToast("ok", t("backupPanel.ok.nothingToRestore"));
        return;
      }
      // Default-select every conflict — the user starts from "restore
      // everything" and unchecks anything they want to keep.
      const selected = new Set(conflicts.map((c) => c.id));
      setRestoreState({ phase: "preview", conflicts, selected, mirror });
    } catch (e) {
      setRestoreState({ phase: "idle" });
      onToast("error", t("backupPanel.errors.restoreScanFailed", { message: describeErr(e) }));
    }
  }

  async function handleRestoreApply(items: ConflictItem[]) {
    if (items.length === 0) {
      onToast("error", t("backupPanel.errors.noFilesSelected"));
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
          t("backupPanel.ok.restoreFailedSome", {
            copied: result.copied,
            deleted: result.deleted,
            failed: result.failed.length,
            sample,
          }),
        );
      } else {
        const deletedSuffix =
          result.deleted > 0
            ? t("backupPanel.ok.restoreDeletedSuffix", { count: result.deleted })
            : "";
        onToast(
          "ok",
          t("backupPanel.ok.restoreSuccess", { copied: result.copied, deletedSuffix }),
        );
      }
    } catch (e) {
      onToast("error", t("backupPanel.errors.restoreFailed", { message: describeErr(e) }));
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
      onToast("error", t("backupPanel.errors.pickDestination"));
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
      onToast("ok", t("backupPanel.ok.scriptsGenerated", { count: result.files.length, dir: outDir }));
      shellOpen(outDir).catch(() => {});
    } catch (e) {
      onToast("error", t("backupPanel.errors.scriptGenerationFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title">{t("backupPanel.title")}</div>

      {/* Backup folder card — the most prominent setting. Without a folder
          the "Back up now" button is disabled, so we want this to read like
          a clear call to action when empty and a status card when filled. */}
      <div className={`backup-folder-card ${backupDestination ? "" : "empty"}`}>
        <div className="backup-folder-icon" aria-hidden="true">
          <FolderIcon size={18} />
        </div>
        <div className="backup-folder-text">
          <div className="backup-folder-label">{t("backupPanel.folderLabel")}</div>
          {backupDestination ? (
            <div className="backup-folder-path" title={backupDestination}>
              {backupDestination}
            </div>
          ) : (
            <div className="backup-folder-hint">
              {t("backupPanel.folderHint")}
            </div>
          )}
        </div>
        <div className="backup-folder-actions">
          {backupDestination ? (
            <>
              <button className="link-btn" onClick={pickDestination} title={t("backupPanel.changeTitle")}>
                {t("backupPanel.changeBtn")}
              </button>
              <button
                className="link-btn"
                onClick={browseBackupFolder}
                title={t("backupPanel.openFolderTitle")}
              >
                {t("backupPanel.openFolderBtn")}
              </button>
              <button
                className="link-btn"
                onClick={() => setConfirmClearDest(true)}
                title={t("backupPanel.clearTitle")}
              >
                {t("backupPanel.clearBtn")}
              </button>
            </>
          ) : (
            <button className="primary" onClick={pickDestination}>
              {t("backupPanel.chooseFolderBtn")}
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
      <div className="settings-row" style={{ flexWrap: "wrap" }}>
        <button
          className="primary"
          onClick={handleBackup}
          disabled={!backupDestination || backupBusy}
          title={
            !backupDestination
              ? t("backupPanel.backupDisabledTitle")
              : backupBusy
                ? t("backupPanel.backupBusyTitle")
                : t("backupPanel.backupRunTitle")
          }
        >
          {backupBusy ? t("backupPanel.backingUp") : t("backupPanel.backupNow")}
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
              ? t("backupPanel.restoreDisabledTitle")
              : t("backupPanel.restoreEnabledTitle")
          }
        >
          {restoreState.phase === "scanning"
            ? t("backupPanel.scanning")
            : restoreState.phase === "applying"
              ? t("backupPanel.restoring")
              : t("backupPanel.restoreBtn")}
        </button>
      </div>

      {backupBusy && backupProgress && (
        <div className="dl-progress" role="status" aria-live="polite">
          <div className="dl-progress-bar">
            {/* Indeterminate animated bar — we don't pre-count files. */}
            <div className="dl-progress-fill backup-progress-indeterminate" />
          </div>
          <div className="dl-progress-label">
            {/*
              Live status line. Prefer the latest line the running script
              has emitted (e.g. "Sync claude · skills (8/14)") so the user
              sees real activity, not the pre-spawn "Starting backup…"
              placeholder. Fall back to backupProgress.phase + counts
              during the manifest-walk phase, when the script is done and
              the JS-side walker is producing the file counts.
            */}
            {(() => {
              const live = latestLogLine();
              if (live) return t("backupPanel.runningPrefix", { line: live });
              if (backupProgress.filesProcessed === 0 && backupProgress.filesCopied === 0) {
                return t("backupPanel.progressPhase", { phase: backupProgress.phase });
              }
              return t("backupPanel.progressLabel", {
                phase: backupProgress.phase,
                filesProcessed: backupProgress.filesProcessed,
                bytesProcessed: formatBytes(backupProgress.bytesProcessed, t),
                filesCopied: backupProgress.filesCopied,
                bytesCopied: formatBytes(backupProgress.bytesCopied, t),
              });
            })()}
          </div>
        </div>
      )}

      {backupLastRun && backupStats && (
        <div className="projects-summary-text" style={{ paddingLeft: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span>
              {t("backupPanel.lastBackupLine", {
                relative: formatRelative(backupLastRun, t),
                added: backupStats.counts.added,
                changed: backupStats.counts.changed,
                removed: backupStats.counts.removed,
                bytes: formatBytes(backupStats.totalBytes, t),
              })}
              {backupStats.errorCount > 0 && (
                <span className="badge drift" style={{ marginLeft: 8 }}>
                  {t("backupPanel.errorBadge", { count: backupStats.errorCount })}
                </span>
              )}
            </span>
            {logTail && (
              // Direct affordance to the log without scrolling — toggles
              // the same showLog state the LOG section header drives so
              // either control reflects the other.
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowLog((s) => !s)}
                title={t("backupPanel.toggleLogTitle")}
              >
                {showLog ? t("backupPanel.hideLogLink") : t("backupPanel.viewLogLink")}
              </button>
            )}
          </div>
          {backupStats.errorSamples && backupStats.errorSamples.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer", color: "var(--error)" }}>
                {backupStats.errorSamples.length === backupStats.errorCount
                  ? t("backupPanel.errorsShowAll", { count: backupStats.errorCount })
                  : t("backupPanel.errorsShowFirst", {
                      shown: backupStats.errorSamples.length,
                      total: backupStats.errorCount,
                    })}
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
                {backupStats.counts.added + backupStats.counts.changed >
                backupStats.recentChanges.length
                  ? t("backupPanel.recentChangesOf", {
                      shown: backupStats.recentChanges.length,
                      total: backupStats.counts.added + backupStats.counts.changed,
                    })
                  : t("backupPanel.recentChanges", { shown: backupStats.recentChanges.length })}
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
                      title={t("backupPanel.openPathTitle", { path: c.destPath })}
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
                      {formatBytes(c.bytes, t)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Log tail — last lines from the platform-specific
          skillsafe-backup.log. Positioned right under Recent changes so
          the user sees what just happened (script-level details) without
          having to scroll through the scheduler section to find it. */}
      <div className="settings-section-title-row" style={{ marginTop: 12 }}>
        <div className="settings-section-title" style={{ fontSize: 12 }}>
          {t("backupPanel.logHeader")}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="link-btn"
            onClick={() => setShowLog((s) => !s)}
            disabled={!logTail}
          >
            {showLog ? t("backupPanel.hide") : t("backupPanel.show")}
          </button>
          <button className="link-btn" onClick={refreshLog}>
            {t("backupPanel.reloadLog")}
          </button>
          {logTail && (
            <button
              className="link-btn"
              onClick={async () => {
                try {
                  const { logPath } = await resolvePlatformPaths();
                  shellOpen(logPath).catch(() => {});
                } catch (e) {
                  onToast("error", t("backupPanel.errors.openFailed", { message: describeErr(e) }));
                }
              }}
            >
              {t("backupPanel.openExternally")}
            </button>
          )}
        </div>
      </div>
      {!logTail ? (
        <div className="projects-empty" style={{ fontSize: 11 }}>
          {t("backupPanel.noLogYet", {
            path:
              platform === "windows"
                ? t("backupPanel.logPathWindows")
                : t("backupPanel.logPathUnix"),
          })}
        </div>
      ) : showLog ? (
        <pre
          ref={logPreRef}
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
          {logTail.text || t("backupPanel.logEmpty")}
        </pre>
      ) : (
        // Collapsed view: show the freshest log line as a one-line preview
        // so the user can tell at a glance what the last run produced
        // ("[date] skillsafe backup started" / "[date] Sync claude · skills")
        // instead of the abstract "Last 80 lines available · 158.5 KB".
        // Falls back to the size summary if the file is empty.
        <button
          type="button"
          className="link-btn"
          onClick={() => setShowLog(true)}
          title={t("backupPanel.toggleLogTitle")}
          style={{
            fontSize: 11,
            paddingLeft: 6,
            textAlign: "left",
            color: "var(--muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "100%",
            display: "block",
          }}
        >
          {latestLogLine()
            || `${logTail.truncated ? t("backupPanel.logLast80") : t("backupPanel.logAvailable")} · ${formatBytes(logTail.bytes, t)}`}
        </button>
      )}

      {/* Daily schedule (macOS launchd) */}
      <div className="settings-section-title-row" style={{ marginTop: 12 }}>
        <div className="settings-section-title" style={{ fontSize: 12 }}>
          {t("backupPanel.dailySchedule")}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="link-btn"
            onClick={handleGenerateScript}
            disabled={!backupDestination || generating}
            title={t("backupPanel.exportScriptTitle")}
          >
            {generating ? t("backupPanel.generating") : t("backupPanel.exportScript")}
          </button>
          <button
            className="link-btn"
            onClick={refreshSchedule}
            disabled={!!scheduleBusy}
            title={
              platform === "windows"
                ? t("backupPanel.refreshWindowsTitle")
                : t("backupPanel.refreshUnixTitle")
            }
          >
            {scheduleBusy === "refresh" ? t("backupPanel.checking") : t("backupPanel.refresh")}
          </button>
          <button
            className="link-btn"
            onClick={runDiagnose}
            title={t("backupPanel.diagnoseTitle")}
          >
            {t("backupPanel.diagnose")}
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
              {scheduleStatusLabel(scheduleStatus, platform, t)}
            </span>
            <div className="settings-row-actions">
              {scheduleStatus.kind === "loaded" ? (
                <>
                  <button
                    className="primary"
                    onClick={handleScheduleRunNow}
                    disabled={!!scheduleBusy}
                  >
                    {scheduleBusy === "run" ? t("backupPanel.running") : t("backupPanel.runNow")}
                  </button>
                  <button
                    className="link-btn"
                    onClick={() => setConfirmUninstall(true)}
                    disabled={!!scheduleBusy}
                  >
                    {scheduleBusy === "uninstall" ? t("backupPanel.uninstalling") : t("backupPanel.uninstall")}
                  </button>
                </>
              ) : scheduleStatus.kind === "installed_not_loaded" ? (
                <>
                  <button
                    className="primary"
                    onClick={handleScheduleInstall}
                    disabled={!!scheduleBusy}
                    title={t("backupPanel.reloadTitle")}
                  >
                    {scheduleBusy === "install" ? t("backupPanel.reloading") : t("backupPanel.reload")}
                  </button>
                  <button
                    className="link-btn"
                    onClick={() => setConfirmUninstall(true)}
                    disabled={!!scheduleBusy}
                  >
                    {scheduleBusy === "uninstall" ? t("backupPanel.uninstalling") : t("backupPanel.uninstall")}
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
                      ? t("backupPanel.schedulerUnavailableWindows")
                      : platform === "linux"
                        ? t("backupPanel.schedulerUnavailableLinux")
                        : t("backupPanel.schedulerUnavailableMac")
                  }
                >
                  {t("backupPanel.schedulerUnavailable")}
                </span>
              ) : (
                <button
                  className="primary"
                  onClick={handleScheduleInstall}
                  disabled={!!scheduleBusy || !backupDestination}
                  title={
                    !backupDestination
                      ? t("backupPanel.installDisabledTitle")
                      : platform === "windows"
                        ? t("backupPanel.installWindowsTitle")
                        : platform === "linux"
                          ? t("backupPanel.installLinuxTitle")
                          : t("backupPanel.installMacTitle")
                  }
                >
                  {scheduleBusy === "install" ? t("backupPanel.installing") : t("backupPanel.installDaily")}
                </button>
              )}
            </div>
          </div>
          <div className="projects-summary-text" style={{ fontSize: 11, paddingLeft: 6 }}>
            {platform === "windows"
              ? t("backupPanel.serviceKindTask")
              : platform === "linux"
                ? t("backupPanel.serviceKindCron")
                : t("backupPanel.serviceKindService")}:{" "}
            <code>{platform === "windows" ? WIN_TASK_NAME : SERVICE_LABEL}</code> ·{" "}
            {scheduleSummary(backupSchedule, t)}
          </div>

          {/* Schedule editor — change the time / weekdays. Pressing Apply
              persists the schedule and (if currently loaded) re-installs the
              plist so launchd picks up the new times. */}
          <div className="settings-section-title-row" style={{ marginTop: 10 }}>
            <div className="settings-section-title" style={{ fontSize: 12 }}>
              {t("backupPanel.scheduleHeader")}
            </div>
            {scheduleDirty && (
              <button
                className="link-btn"
                onClick={() => setDraftSchedule(backupSchedule)}
                title={t("backupPanel.resetTitle")}
              >
                {t("backupPanel.reset")}
              </button>
            )}
          </div>
          <div
            className="settings-row"
            style={{ alignItems: "center", flexWrap: "wrap", gap: 8 }}
          >
            <label className="settings-row-label" style={{ minWidth: 60 }}>
              {t("backupPanel.timeLabel")}
            </label>
            <input
              type="number"
              min={0}
              max={23}
              value={draftSchedule.hour}
              onChange={(e) => setDraftHour(parseInt(e.target.value, 10))}
              className="settings-select"
              style={{ width: 64 }}
              aria-label={t("backupPanel.hourAria")}
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
              aria-label={t("backupPanel.minuteAria")}
            />
            <span style={{ color: "var(--muted)", fontSize: 11 }}>
              {t("backupPanel.timeHint")}
            </span>
          </div>
          <div className="settings-row" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <label className="settings-row-label" style={{ minWidth: 60 }}>
              {t("backupPanel.daysLabel")}
            </label>
            <div className="pill-row" style={{ flexWrap: "wrap" }}>
              {WEEKDAY_KEYS.map((key, i) => {
                const label = t(`backupPanel.weekdays.${key}`);
                const active =
                  (draftSchedule.weekdays ?? []).length === 0
                    ? false
                    : (draftSchedule.weekdays ?? []).includes(i);
                return (
                  <div
                    key={key}
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
                  ? t("backupPanel.everyDay")
                  : t("backupPanel.daysSelected", { count: (draftSchedule.weekdays ?? []).length })}
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
                {scheduleBusy === "install" ? t("backupPanel.applying") : t("backupPanel.applySchedule")}
              </button>
            </div>
          )}

          {/* TCC/permission diagnostics inferred from the latest log lines.
              Surfaces a guided fix when rsync hit "Operation not permitted"
              on a CloudStorage destination, so the user doesn't have to
              read raw rsync output to know what's wrong. */}
          {logIssues.map((issue) => (
            <div
              key={issue.kind}
              role="alert"
              style={{
                marginTop: 10,
                padding: 10,
                background: "rgba(212, 70, 70, 0.08)",
                border: "1px solid rgba(212, 70, 70, 0.35)",
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {t("backupPanel.logIssue.tccTitle", { count: issue.paths.length })}
              </div>
              <div style={{ opacity: 0.85, marginBottom: 8 }}>
                {t("backupPanel.logIssue.tccBody")}
              </div>
              <ul style={{ margin: "0 0 8px 16px", padding: 0, lineHeight: 1.5 }}>
                {issue.paths.map((p) => (
                  <li key={p} style={{ wordBreak: "break-all" }}>
                    <code style={{ fontSize: 11 }}>{p}</code>{" "}
                    <button
                      className="link-btn"
                      style={{ fontSize: 11 }}
                      onClick={() => shellOpen(p).catch(() => {})}
                    >
                      {t("backupPanel.logIssue.reveal")}
                    </button>
                  </li>
                ))}
              </ul>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <button
                  className="link-btn"
                  onClick={() => setShowFixSteps((s) => !s)}
                >
                  {showFixSteps
                    ? t("backupPanel.logIssue.hideFix")
                    : t("backupPanel.logIssue.showFix")}
                </button>
                <button className="link-btn" onClick={refreshLog}>
                  {t("backupPanel.logIssue.recheck")}
                </button>
              </div>
              {showFixSteps && (
                <ol
                  style={{
                    margin: "8px 0 0 16px",
                    padding: 0,
                    lineHeight: 1.6,
                    opacity: 0.9,
                  }}
                >
                  <li>{t("backupPanel.logIssue.fixQuick")}</li>
                  <li>{t("backupPanel.logIssue.fixDurable")}</li>
                </ol>
              )}
            </div>
          ))}

          {diag && (
            <details style={{ marginTop: 10 }} open>
              <summary style={{ cursor: "pointer", fontSize: 12 }}>
                {t("backupPanel.diagnostics")}
                <button
                  className="link-btn"
                  onClick={(e) => { e.preventDefault(); setDiag(null); }}
                  style={{ marginLeft: 8, fontSize: 11, padding: "2px 6px" }}
                >
                  {t("backupPanel.hide")}
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
              <h3>{t("backupPanel.restoringTitle")}</h3>
            </header>
            <div className="settings-body">
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                {t("backupPanel.filesProgress", { done: restoreState.done, total: restoreState.total })}
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
          title={t("backupPanel.forgetTitle")}
          message={
            <>
              <div>{t("backupPanel.forgetMessageIntro")}</div>
              <div className="confirm-target-path">{backupDestination}</div>
              <div className="confirm-warning" style={{ marginTop: 8 }}>
                {t("backupPanel.forgetMessageWarn")}
              </div>
            </>
          }
          confirmLabel={t("backupPanel.forgetConfirm")}
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
          title={t("backupPanel.uninstallTitle")}
          message={
            <>
              <div>
                {platform === "windows"
                  ? t("backupPanel.uninstallMessageWindows")
                  : platform === "linux"
                    ? t("backupPanel.uninstallMessageLinux")
                    : t("backupPanel.uninstallMessageMac")}{" "}
                <code>{platform === "windows" ? WIN_TASK_NAME : SERVICE_LABEL}</code>
                {t("backupPanel.uninstallMessageTail")}
              </div>
              <div className="confirm-warning" style={{ marginTop: 8 }}>
                {t("backupPanel.uninstallMessageWarn")}
              </div>
            </>
          }
          confirmLabel={t("backupPanel.uninstallConfirm")}
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

function scheduleStatusLabel(s: ScheduleStatus, platform: BackupPlatform, t: TFunction): string {
  if (s.kind === "not_installed") return t("backupPanel.status.notInstalled");
  if (s.kind === "unsupported") {
    if (platform === "windows") return t("backupPanel.status.unsupportedWindows");
    if (platform === "linux") return t("backupPanel.status.unsupportedLinux");
    return t("backupPanel.status.unsupportedMac");
  }
  if (s.kind === "installed_not_loaded") return t("backupPanel.status.installedNotLoaded");
  // loaded — pid is a Windows running-flag sentinel (1) or the real macOS PID
  if (s.pid !== null && s.pid > 0) {
    return platform === "windows"
      ? t("backupPanel.status.runningWindows")
      : t("backupPanel.status.runningMac", { pid: s.pid });
  }
  if (s.lastExitCode !== null && s.lastExitCode !== 0) {
    return t("backupPanel.status.loadedExited", { code: s.lastExitCode });
  }
  return t("backupPanel.status.loadedIdle");
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
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function scheduleSummary(s: ScheduleSpec, t: TFunction): string {
  const hh = String(s.hour).padStart(2, "0");
  const mm = String(s.minute).padStart(2, "0");
  const days = s.weekdays ?? [];
  if (days.length === 0 || days.length === 7) {
    return t("backupPanel.scheduleSummaryDaily", { hour: hh, minute: mm });
  }
  const labels = days.map((d) => t(`backupPanel.weekdays.${WEEKDAY_KEYS[d]}`)).join(", ");
  return t("backupPanel.scheduleSummaryDays", { hour: hh, minute: mm, days: labels });
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
/**
 * Spawn the platform-appropriate backup script and stream its stdout into
 * `onPhase` callbacks so the UI shows live "[N/M] Sync …" progress instead
 * of a stuck "scanned 0 · copied 0" label. Returns the same shape
 * `Command.execute()` would have returned so the caller stays simple.
 *
 * The script's log() helper prints lines like
 *   [2026-05-13 22:00:01] [3/12] Sync Claude Code · Skills ...
 * and a matching "[3/12] OK ..." when the section finishes. We surface
 * just the Sync line — that's the actionable one. Anything we can't parse
 * (banners, warnings, OK lines) is logged via console.debug for support.
 */
async function runScriptStreaming(
  scriptPath: string,
  onPhase: (phase: string) => void,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const isWindows = (await osType()) === "windows";
  const cmd = isWindows
    ? Command.create("powershell", [
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ])
    : Command.create("bash", [scriptPath]);

  // Capture full stdout/stderr so the error toast can still show useful
  // context if the script exits non-zero — the live progress is just a
  // UI nicety on top of that.
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Match "[N/M] Sync <tool> · <data type> ..." after the optional
  // log-helper timestamp prefix. Group 1 = step, 2 = total, 3 = label.
  const SYNC_RE = /\[(\d+)\/(\d+)\]\s+Sync\s+(.+?)(?:\s*\.\.\.\s*)?$/;

  cmd.stdout.on("data", (raw: string) => {
    stdoutChunks.push(raw);
    // Tauri emits a "data" event per line by default; split defensively
    // in case the runtime buffers multiple lines together.
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      const m = SYNC_RE.exec(line);
      if (m) {
        onPhase(`${m[1]}/${m[2]} · ${m[3].trim()}`);
      }
    }
  });
  cmd.stderr.on("data", (raw: string) => {
    stderrChunks.push(raw);
  });

  return await new Promise((resolve, reject) => {
    cmd.on("close", (ev: { code: number | null }) => {
      resolve({
        code: ev.code,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      });
    });
    cmd.on("error", (err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    cmd.spawn().catch(reject);
  });
}

function friendlyBackupError(raw: string, t: TFunction): string {
  const m = /forbidden path:\s*([^,]+)/i.exec(raw);
  if (m) {
    const path = m[1].trim();
    return t("backupPanel.errors.forbiddenPath", { path });
  }
  return raw;
}

// detectPlatform moved to lib/backup/appPaths.ts so the BackupBrowser can
// share it without re-implementing the UA-fallback logic.

function formatRelative(ts: number, t: TFunction): string {
  const ms = Date.now() - ts;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t("backupPanel.relative.justNow");
  if (minutes < 60) return t("backupPanel.relative.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("backupPanel.relative.hours", { count: hours });
  const days = Math.floor(hours / 24);
  return t("backupPanel.relative.days", { count: days });
}

function formatBytes(n: number, t: TFunction): string {
  if (n < 1024) return t("backupPanel.bytes.b", { n });
  if (n < 1024 * 1024) return t("backupPanel.bytes.kb", { n: (n / 1024).toFixed(1) });
  if (n < 1024 * 1024 * 1024) return t("backupPanel.bytes.mb", { n: (n / 1024 / 1024).toFixed(1) });
  return t("backupPanel.bytes.gb", { n: (n / 1024 / 1024 / 1024).toFixed(2) });
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
  const { t } = useTranslation();
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
          <h3>{t("backupPanel.restoreDialog.header", { count: total })}</h3>
          <button
            className="settings-close icon-btn"
            aria-label={t("backupPanel.restoreDialog.closeAria")}
            onClick={onCancel}
          >
            ×
          </button>
        </header>
        <div className="settings-body">
          <div
            style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}
            dangerouslySetInnerHTML={{
              __html:
                t("backupPanel.restoreDialog.intro", { destination: backupDestination }) +
                (mirror ? t("backupPanel.restoreDialog.mirrorNote") : ""),
            }}
          />
          <div className="restore-toolbar">
            <span className="restore-count">
              {t("backupPanel.restoreDialog.countSelected", { selected: selCount, total })}
            </span>
            <button className="link-btn" onClick={() => onToggleAll(true)} disabled={allOn}>
              {t("backupPanel.restoreDialog.selectAll")}
            </button>
            <button className="link-btn" onClick={() => onToggleAll(false)} disabled={selCount === 0}>
              {t("backupPanel.restoreDialog.deselectAll")}
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
                              ? t("backupPanel.restoreDialog.kindNew")
                              : c.kind === "modified"
                                ? t("backupPanel.restoreDialog.kindModify")
                                : t("backupPanel.restoreDialog.kindDelete")}
                          </span>
                          <span className="restore-rel" title={c.dstPath}>
                            {c.rel}
                          </span>
                          <span className="restore-size">
                            {c.kind === "extra"
                              ? formatBytes(c.dstSize ?? 0, t)
                              : c.kind === "modified" && c.dstSize !== null
                                ? `${formatBytes(c.dstSize, t)} → ${formatBytes(c.srcSize ?? 0, t)}`
                                : formatBytes(c.srcSize ?? 0, t)}
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
          <button onClick={onCancel}>{t("backupPanel.restoreDialog.cancel")}</button>
          <button className="primary danger" onClick={onConfirm} disabled={selCount === 0}>
            {t("backupPanel.restoreDialog.restoreCount", { count: selCount })}
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
  const { t } = useTranslation();
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
    ? tools.filter((x) => x.id.toLowerCase().includes(lc) || x.label.toLowerCase().includes(lc))
    : showAll
      ? tools
      : tools.filter((x) => selected.includes(x.id));
  const enabledCount = selected.length;
  return (
    <div className="backup-tools-picker">
      <div className="settings-section-title-row">
        <div className="settings-section-title" style={{ fontSize: 12 }}>
          {t("backupPanel.picker.header", { count: enabledCount })}
        </div>
        <input
          type="search"
          className="backup-tools-filter"
          placeholder={t("backupPanel.picker.filterPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={t("backupPanel.picker.filterAria")}
        />
      </div>
      {visible.length === 0 ? (
        <div className="projects-empty" style={{ fontSize: 11 }}>
          {lc ? t("backupPanel.picker.noneMatch") : t("backupPanel.picker.noneSelected")}
        </div>
      ) : (
        <ul className="backup-tools-list">
          {visible.map((tool) => {
            const enabled = selected.includes(tool.id);
            const types = dataTypesFor(tool.id);
            const flat = types.length === 1 && types[0].id === "all";
            const ids = dataTypeSelection[tool.id] ?? [];
            const expanded = enabled && !flat && !collapsed.has(tool.id);
            return (
              <li
                key={tool.id}
                className={`backup-tool-card ${enabled ? "active" : ""}`}
                title={tool.tooltip}
              >
                <div className="backup-tool-card-head">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => onToggleTool(tool.id)}
                    aria-label={t("backupPanel.picker.selectAria", { label: tool.label })}
                  />
                  <button
                    type="button"
                    className="backup-tool-card-nametoggle"
                    onClick={() => {
                      if (!flat && enabled) toggleCollapsed(tool.id);
                      else onToggleTool(tool.id);
                    }}
                    aria-expanded={!flat ? expanded : undefined}
                    title={tool.tooltip}
                  >
                    <span className="backup-tool-card-name">{tool.label}</span>
                    <span className="backup-tool-card-meta">
                      {flat
                        ? t("backupPanel.picker.allConfigFiles")
                        : enabled
                          ? t("backupPanel.picker.selectedDataTypes", { selected: ids.length, total: types.length })
                          : t("backupPanel.picker.dataTypeCount", { count: types.length })}
                    </span>
                  </button>
                </div>
                {expanded && (
                  <ul className="backup-data-type-list">
                    {types.map((dt) => {
                      const on = ids.includes(dt.id);
                      const camel = dataTypeI18nKey(dt.id);
                      const label = t(`categories.${camel}`, { defaultValue: dt.label });
                      const desc = dt.description
                        ? t(`categories.${camel}Desc`, { defaultValue: dt.description })
                        : "";
                      return (
                        <li key={dt.id} className="backup-data-type-row">
                          <label className="backup-data-type-label">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={(e) => onToggleDataType(tool.id, dt.id, e.target.checked)}
                            />
                            <span className="backup-data-type-name">{label}</span>
                          </label>
                          {desc && (
                            <div className="backup-data-type-desc">{desc}</div>
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
          {showAll
            ? t("backupPanel.picker.hideUnselected")
            : t("backupPanel.picker.showAll", { count: tools.length })}
        </button>
      )}
    </div>
  );
}

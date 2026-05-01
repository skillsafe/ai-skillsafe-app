import { Command } from "@tauri-apps/plugin-shell";

export const SERVICE_LABEL = "ai.skillsafe.backup";

export type ScheduleStatus =
  | { kind: "not_installed" }
  // Plist exists in ~/Library/LaunchAgents but launchd hasn't reported it as
  // loaded — typically means the user needs to log out/in (or hit Reload),
  // or macOS Sequoia is awaiting Background-Items approval.
  | { kind: "installed_not_loaded" }
  // Loaded into launchd. `pid > 0` indicates the job is currently running, 0
  // is registered but idle, null means launchd hasn't reported PID yet.
  | { kind: "loaded"; pid: number | null; lastExitCode: number | null }
  | { kind: "unsupported" };

export interface ScheduleContext {
  // Source plist path inside the user's destination's `scheduled-backup/`
  // folder. Generate-scripts writes it; install copies it into LaunchAgents.
  sourcePlistPath: string;
  // ~/Library/LaunchAgents/<LABEL>.plist
  installedPlistPath: string;
}

let cachedUid: string | null = null;

export async function getUid(): Promise<string> {
  if (cachedUid) return cachedUid;
  const out = await Command.create("id", ["-u"]).execute();
  if (out.code !== 0) throw new Error(`id -u failed: ${out.stderr}`);
  cachedUid = out.stdout.trim();
  if (!/^\d+$/.test(cachedUid)) throw new Error(`id -u returned unexpected value: ${cachedUid}`);
  return cachedUid;
}

export interface GetStatusOptions {
  // Optional: pass an `exists` predicate to detect "installed but not loaded"
  // (plist file present, but launchd doesn't know about it). Without this we
  // can only return `not_installed` vs `loaded`.
  installedPlistPath?: string;
  exists?: (path: string) => Promise<boolean>;
}

export async function getStatus(opts: GetStatusOptions = {}): Promise<ScheduleStatus> {
  let uid: string;
  try {
    uid = await getUid();
  } catch {
    return { kind: "unsupported" };
  }

  // Probe 1: `launchctl list <label>` — the most direct query. Exits 0 if
  // loaded, 113 if not. (Bare `list` returns columns; with a label arg it
  // returns the plist as XML on stdout.)
  const listOne = await Command.create("launchctl", ["list", SERVICE_LABEL]).execute();
  if (listOne.code === 0) {
    // listOne.stdout is the loaded job's plist XML — parse PID + LastExitStatus.
    const stdout = listOne.stdout;
    const pidMatch = /<key>PID<\/key>\s*<integer>(-?\d+)<\/integer>/.exec(stdout);
    const exitMatch = /<key>LastExitStatus<\/key>\s*<integer>(-?\d+)<\/integer>/.exec(stdout);
    return {
      kind: "loaded",
      pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
      lastExitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
    };
  }

  // Probe 2: `launchctl print gui/<uid>/<label>` — authoritative for services
  // that loaded via legacy `load -w` and that bare `list` somehow misses.
  const print = await Command.create("launchctl", [
    "print",
    `gui/${uid}/${SERVICE_LABEL}`,
  ]).execute();
  if (print.code === 0) {
    const pidMatch = /\bpid\s*=\s*(\d+)/i.exec(print.stdout);
    const exitMatch = /\blast exit code\s*=\s*([\-\d]+)/i.exec(print.stdout);
    return {
      kind: "loaded",
      pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
      lastExitCode:
        exitMatch && exitMatch[1] !== "-" ? parseInt(exitMatch[1], 10) : null,
    };
  }

  // Probe 3: file presence. If the plist is on disk, the user *did* install,
  // launchd just hasn't picked it up yet. Surface that distinct state so the
  // UI doesn't claim "Not installed" right after a successful install.
  if (opts.installedPlistPath && opts.exists && (await opts.exists(opts.installedPlistPath))) {
    return { kind: "installed_not_loaded" };
  }

  return { kind: "not_installed" };
}

export interface InstallOptions {
  // Read source plist contents through the FS adapter so the caller controls
  // how we read across capability scopes. Returns the bytes to write into
  // ~/Library/LaunchAgents.
  sourcePlistContents: string;
  // Where to write the plist in the user's LaunchAgents.
  installedPlistPath: string;
  writeFile: (path: string, contents: string) => Promise<void>;
}

// Each launchctl/plutil invocation we made during install, with its raw
// output. Surfaced via state so Diagnose can show the user exactly what the
// system said at each step (helpful when bootstrap returns 0 but the agent
// silently fails to load).
export interface InstallStep {
  cmd: string;
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
}

let lastInstallTranscript: InstallStep[] = [];

export function getLastInstallTranscript(): InstallStep[] {
  return lastInstallTranscript.slice();
}

async function recordedExec(cmd: string, args: string[]): Promise<InstallStep> {
  const out = await Command.create(cmd, args).execute();
  const step: InstallStep = {
    cmd,
    args,
    code: out.code ?? -1,
    stdout: (out.stdout || "").trim(),
    stderr: (out.stderr || "").trim(),
  };
  lastInstallTranscript.push(step);
  return step;
}

export async function install(opts: InstallOptions): Promise<void> {
  lastInstallTranscript = [];
  // 1. Copy plist into LaunchAgents (atomicity not critical — plist is small).
  await opts.writeFile(opts.installedPlistPath, opts.sourcePlistContents);
  // 2. Validate the plist with plutil. launchctl returns an opaque "Input/
  // output error" when the plist is malformed, so a pre-flight lint gives the
  // user a real diagnostic.
  const lint = await recordedExec("plutil", ["-lint", opts.installedPlistPath]);
  if (lint.code !== 0) {
    throw new Error(`Plist failed validation: ${lint.stderr || lint.stdout}`);
  }
  // 3. Try bootstrap (modern), then fall back to the legacy load path.
  const uid = await getUid();
  await safeBootoutRecorded(uid, opts.installedPlistPath);
  // 3a. After bootout, launchd marks the service "disabled" in its override
  // database. Subsequent bootstrap calls silently no-op (return 0 but never
  // actually register the agent) because launchd treats the disabled state as
  // user intent. Clear that override before bootstrap.
  await recordedExec("launchctl", ["enable", `gui/${uid}/${SERVICE_LABEL}`]);
  const bootstrap = await recordedExec("launchctl", [
    "bootstrap",
    `gui/${uid}`,
    opts.installedPlistPath,
  ]);
  if (bootstrap.code === 0) {
    // Belt-and-suspenders: verify the service is now actually loaded. If
    // bootstrap silently no-op'd anyway, fall through to the legacy load.
    const verify = await recordedExec("launchctl", ["list", SERVICE_LABEL]);
    if (verify.code === 0) return;
  }

  // Fallback: `launchctl load -w` (deprecated but still functional).
  const load = await recordedExec("launchctl", [
    "load",
    "-w",
    opts.installedPlistPath,
  ]);
  if (load.code === 0) {
    const verify2 = await recordedExec("launchctl", ["list", SERVICE_LABEL]);
    if (verify2.code === 0) return;
  }

  // Both failed — surface a clear diagnosis with a manual fallback command.
  // EIO from launchctl on every operation against the plist usually means
  // macOS TCC is blocking this unsigned dev binary from manipulating
  // LaunchAgents. Running the same commands in Terminal works because Terminal
  // has user-granted file access. Hand the user a one-liner.
  const looksTccBlocked =
    /input\/output error/i.test(bootstrap.stderr || bootstrap.stdout) ||
    /input\/output error/i.test(load.stderr || load.stdout);
  const manualCmd =
    `launchctl bootout gui/${uid}/${SERVICE_LABEL} 2>/dev/null; ` +
    `launchctl enable gui/${uid}/${SERVICE_LABEL}; ` +
    `launchctl bootstrap gui/${uid} '${opts.installedPlistPath}'`;

  let header: string;
  if (looksTccBlocked) {
    header =
      "launchctl install failed (Input/output error). This usually means " +
      "macOS is blocking this app from managing LaunchAgents — common in dev " +
      "builds. Paste the line below into Terminal to install the schedule:";
  } else {
    header = "launchctl install failed.";
  }

  throw new Error(
    `${header}\n\n${manualCmd}\n\n` +
      `bootstrap (${bootstrap.code}): ${bootstrap.stderr || bootstrap.stdout}\n` +
      `load -w (${load.code}): ${load.stderr || load.stdout}\n` +
      `plist path: ${opts.installedPlistPath}`,
  );
}

export interface UninstallOptions {
  installedPlistPath: string;
  removeFile: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
}

// Result returned by uninstall(). When the bootout succeeds but the plist
// file can't be deleted (macOS protects ~/Library/LaunchAgents/ at the OS
// level), `removed` is false and the caller should surface a manual `rm`
// instruction. The service itself is still effectively stopped — bootout
// always runs first.
export interface UninstallResult {
  removed: boolean;
  manualCommand?: string;
  reason?: string;
}

export async function uninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const uid = await getUid();
  await safeBootout(uid, opts.installedPlistPath);
  if (!(await opts.exists(opts.installedPlistPath))) {
    return { removed: true };
  }
  try {
    await opts.removeFile(opts.installedPlistPath);
    return { removed: true };
  } catch (e) {
    return {
      removed: false,
      reason: e instanceof Error ? e.message : String(e),
      manualCommand: `rm "${opts.installedPlistPath}"`,
    };
  }
}

export async function runNow(): Promise<void> {
  const uid = await getUid();
  const out = await Command.create("launchctl", [
    "kickstart",
    "-k",
    `gui/${uid}/${SERVICE_LABEL}`,
  ]).execute();
  if (out.code !== 0) {
    throw new Error(`launchctl kickstart failed (${out.code}): ${out.stderr || out.stdout}`);
  }
}

// Tail of the launchd-managed script's log. Returns up to maxLines of the
// newest log lines; undefined when the log file doesn't exist (the schedule
// has never run yet).
export interface LogTail {
  text: string;
  truncated: boolean;
  bytes: number;
}

export async function readLogTail(
  readTextFile: (path: string) => Promise<string>,
  exists: (path: string) => Promise<boolean>,
  logPath: string,
  maxLines = 80,
): Promise<LogTail | null> {
  if (!(await exists(logPath))) return null;
  const text = await readTextFile(logPath);
  const lines = text.split(/\r?\n/);
  // Drop trailing empty line (final newline).
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const truncated = lines.length > maxLines;
  const slice = truncated ? lines.slice(-maxLines) : lines;
  return { text: slice.join("\n"), truncated, bytes: text.length };
}

async function safeBootoutRecorded(uid: string, plistPath?: string): Promise<void> {
  await recordedExec("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`]);
  if (plistPath) {
    await recordedExec("launchctl", ["bootout", `gui/${uid}`, plistPath]);
    await recordedExec("launchctl", ["unload", plistPath]);
  }
  await recordedExec("launchctl", ["remove", SERVICE_LABEL]);
}

async function safeBootout(uid: string, plistPath?: string): Promise<void> {
  // launchd holds onto stale registrations more stubbornly than its docs
  // suggest. Try multiple unload paths so a re-install after a previous
  // bootstrap+EIO doesn't get tripped by leftover state. Each command's
  // failure is benign — the service just isn't loaded that way.
  await Command.create("launchctl", [
    "bootout",
    `gui/${uid}/${SERVICE_LABEL}`,
  ]).execute();
  if (plistPath) {
    await Command.create("launchctl", ["bootout", `gui/${uid}`, plistPath]).execute();
    await Command.create("launchctl", ["unload", plistPath]).execute();
  }
  await Command.create("launchctl", ["remove", SERVICE_LABEL]).execute();
}

// Run a battery of probes and return their raw output for the Diagnose UI.
// Each command's full stdout/stderr/exit-code is included so the user can
// paste the result if they need to debug further.
export interface DiagnosticResult {
  uid: string | null;
  installedPlistExists: boolean;
  installedPlistPath: string;
  scriptExists: boolean | null;
  scriptPath: string | null;
  lintCode: number;
  lintOutput: string;
  listCode: number;
  listOutput: string;
  printCode: number;
  printOutput: string;
  // Whether launchd has the agent's disabled override set. Pasted as-is from
  // `launchctl print-disabled gui/<uid>` so the user can see *why* a bootstrap
  // might silently fail.
  disabledOverridesCode: number;
  disabledOverridesOutput: string;
  // Full per-step output from the most recent install attempt, populated by
  // install(). Empty array if install was never called this session.
  installTranscript: InstallStep[];
}

export interface DiagnoseOptions {
  installedPlistPath: string;
  exists: (path: string) => Promise<boolean>;
  // Returns the script path referenced in the installed plist, if we can
  // figure it out. The caller is expected to have generated a fresh local
  // copy and knows that path.
  scriptPath?: string;
}

export async function diagnose(opts: DiagnoseOptions): Promise<DiagnosticResult> {
  let uid: string | null = null;
  try { uid = await getUid(); } catch { /* leave null */ }
  const installedPlistExists = await opts.exists(opts.installedPlistPath);
  const scriptExists = opts.scriptPath ? await opts.exists(opts.scriptPath) : null;

  const lint = installedPlistExists
    ? await Command.create("plutil", ["-lint", opts.installedPlistPath]).execute()
    : { code: -1, stdout: "", stderr: "(plist not installed)" };

  const list = await Command.create("launchctl", ["list", SERVICE_LABEL]).execute();
  const print = uid
    ? await Command.create("launchctl", ["print", `gui/${uid}/${SERVICE_LABEL}`]).execute()
    : { code: -1, stdout: "", stderr: "(no uid)" };
  const disabled = uid
    ? await Command.create("launchctl", ["print-disabled", `gui/${uid}`]).execute()
    : { code: -1, stdout: "", stderr: "(no uid)" };

  return {
    uid,
    installedPlistExists,
    installedPlistPath: opts.installedPlistPath,
    scriptExists,
    scriptPath: opts.scriptPath ?? null,
    lintCode: lint.code ?? -1,
    lintOutput: (lint.stdout || lint.stderr || "").trim(),
    listCode: list.code ?? -1,
    listOutput: (list.stdout || list.stderr || "").trim(),
    printCode: print.code ?? -1,
    printOutput: (print.stdout || print.stderr || "").trim(),
    disabledOverridesCode: disabled.code ?? -1,
    disabledOverridesOutput: extractLabelDisabledLine(
      (disabled.stdout || disabled.stderr || "").trim(),
    ),
    installTranscript: getLastInstallTranscript(),
  };
}

// `launchctl print-disabled` dumps every label in the user's gui domain.
// Pull out only the line for our service so the diagnose UI stays readable.
function extractLabelDisabledLine(text: string): string {
  if (!text) return "";
  const match = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.includes(`"${SERVICE_LABEL}"`) || l.endsWith(SERVICE_LABEL));
  return match ?? "(label not present in disabled overrides)";
}

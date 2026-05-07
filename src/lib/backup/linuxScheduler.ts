// Linux analogue of scheduler.ts. Uses the user's crontab via crontab(1).
//
// Status shape mirrors winScheduler.ts so BackupPanel can reuse the same
// rendering. cron does not expose a PID for scheduled jobs, so "loaded" with
// pid=null is the only running state we can report — there is no "currently
// executing" branch.
//
//   { kind: "not_installed" }                       — no tagged line in crontab
//   { kind: "loaded"; pid: null; lastExitCode: null } — tagged line present
//   { kind: "unsupported" }                         — crontab(1) unavailable
//
// Identification: every line we own ends with "# ai.skillsafe.backup". Other
// lines in the user's crontab are preserved untouched on install/uninstall.

import { Command } from "@tauri-apps/plugin-shell";
import type { ScheduleSpec } from "./generateScripts";

export const LINUX_CRON_MARKER = "# ai.skillsafe.backup";

export type LinuxScheduleStatus =
  | { kind: "not_installed" }
  | { kind: "loaded"; pid: null; lastExitCode: null }
  | { kind: "unsupported" };

interface CrontabRead {
  text: string;
  exists: boolean; // false when crontab returned "no crontab for user"
}

async function readCrontab(): Promise<CrontabRead | null> {
  let out;
  try {
    out = await Command.create("crontab", ["-l"]).execute();
  } catch {
    return null;
  }
  // exit 0 = crontab printed; exit 1 = "no crontab for user" (a non-error
  // empty state on every distro we've checked: GNU mcron, vixie cron, cronie).
  if (out.code === 0) return { text: out.stdout, exists: true };
  if (out.code === 1) return { text: "", exists: false };
  return null;
}

export async function linuxGetStatus(): Promise<LinuxScheduleStatus> {
  const r = await readCrontab();
  if (r === null) return { kind: "unsupported" };
  if (hasMarker(r.text)) {
    return { kind: "loaded", pid: null, lastExitCode: null };
  }
  return { kind: "not_installed" };
}

export interface LinuxInstallOptions {
  scriptPath: string;
  schedule: ScheduleSpec;
  // Path under the app's scheduled-backup/ folder where we drop the new
  // crontab body before piping it back via `crontab <file>`. Lives inside the
  // existing fs scope so we don't have to widen capabilities for /tmp.
  stagePath: string;
  writeFile: (path: string, contents: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
}

export async function linuxInstall(opts: LinuxInstallOptions): Promise<void> {
  const r = await readCrontab();
  if (r === null) throw new Error("crontab(1) unavailable on this system.");
  const cronLine = `${formatScheduleFields(opts.schedule)} ${shellQuote(opts.scriptPath)} ${LINUX_CRON_MARKER}`;
  const next = stripMarker(r.text).trimEnd() + (r.text && stripMarker(r.text).trim() ? "\n" : "") + cronLine + "\n";
  await opts.writeFile(opts.stagePath, next);
  try {
    const out = await Command.create("crontab", [opts.stagePath]).execute();
    if (out.code !== 0) {
      throw new Error(`crontab install failed (${out.code}): ${out.stderr || out.stdout}`);
    }
  } finally {
    // Best-effort cleanup. Leaving the stage file behind isn't harmful (it's
    // inside our app data dir) but keeping it tidy avoids confusion when the
    // user pokes around.
    try { await opts.removeFile(opts.stagePath); } catch { /* ignore */ }
  }
}

export interface LinuxUninstallOptions {
  stagePath: string;
  writeFile: (path: string, contents: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
}

export async function linuxUninstall(
  opts: LinuxUninstallOptions,
): Promise<{ removed: boolean }> {
  const r = await readCrontab();
  if (r === null) throw new Error("crontab(1) unavailable on this system.");
  if (!hasMarker(r.text)) return { removed: true };
  const cleaned = stripMarker(r.text);
  if (cleaned.trim().length === 0) {
    // No surviving lines — empty out the user's crontab entirely. crontab -r
    // is the canonical way to do this; it returns 0 even if there was no
    // crontab to begin with on most modern crons.
    const out = await Command.create("crontab", ["-r"]).execute();
    if (out.code !== 0) {
      throw new Error(`crontab -r failed (${out.code}): ${out.stderr || out.stdout}`);
    }
    return { removed: true };
  }
  await opts.writeFile(opts.stagePath, cleaned.trimEnd() + "\n");
  try {
    const out = await Command.create("crontab", [opts.stagePath]).execute();
    if (out.code !== 0) {
      throw new Error(`crontab uninstall failed (${out.code}): ${out.stderr || out.stdout}`);
    }
    return { removed: true };
  } finally {
    try { await opts.removeFile(opts.stagePath); } catch { /* ignore */ }
  }
}

export async function linuxRunNow(scriptPath: string): Promise<void> {
  // cron has no "run this job now" — just exec the script directly. The same
  // bash that cron would invoke is what we run, so the manual + scheduled
  // paths share one execution model.
  const out = await Command.create("bash", [scriptPath]).execute();
  // Backup script exit codes: 0 = clean, 2 = ran with non-fatal failures.
  if (out.code !== 0 && out.code !== 2) {
    throw new Error(`bash ${scriptPath} failed (${out.code}): ${out.stderr || out.stdout}`);
  }
}

export interface LinuxDiagnosticResult {
  cronAvailable: boolean;
  cronHasOurLine: boolean;
  cronLine: string | null;
  scriptPath: string | null;
  scriptExists: boolean | null;
  crontabReadCode: number;
  crontabReadOutput: string;
}

export async function linuxDiagnose(opts: {
  scriptPath?: string;
  exists?: (p: string) => Promise<boolean>;
}): Promise<LinuxDiagnosticResult> {
  let read;
  try {
    read = await Command.create("crontab", ["-l"]).execute();
  } catch (e) {
    return {
      cronAvailable: false,
      cronHasOurLine: false,
      cronLine: null,
      scriptPath: opts.scriptPath ?? null,
      scriptExists:
        opts.scriptPath && opts.exists ? await opts.exists(opts.scriptPath) : null,
      crontabReadCode: -1,
      crontabReadOutput: e instanceof Error ? e.message : String(e),
    };
  }
  const text = read.code === 0 ? read.stdout : "";
  const ourLine = findMarkerLine(text);
  return {
    cronAvailable: true,
    cronHasOurLine: ourLine !== null,
    cronLine: ourLine,
    scriptPath: opts.scriptPath ?? null,
    scriptExists:
      opts.scriptPath && opts.exists ? await opts.exists(opts.scriptPath) : null,
    crontabReadCode: read.code ?? -1,
    crontabReadOutput: (read.stdout || read.stderr || "").trim(),
  };
}

// ---- helpers (exported for tests) ----

export function hasMarker(text: string): boolean {
  return findMarkerLine(text) !== null;
}

export function stripMarker(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.includes(LINUX_CRON_MARKER))
    .join("\n");
}

export function findMarkerLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (line.includes(LINUX_CRON_MARKER)) return line;
  }
  return null;
}

// "MM HH * * <weekday-list>" cron fields. Weekdays follow cron's 0=Sunday
// convention which matches the ScheduleSpec convention.
export function formatScheduleFields(s: ScheduleSpec): string {
  const hh = clamp(s.hour, 0, 23);
  const mm = clamp(s.minute, 0, 59);
  const days = (s.weekdays ?? []).filter((d) => d >= 0 && d <= 6);
  const dow = days.length === 0 ? "*" : Array.from(new Set(days)).sort().join(",");
  return `${mm} ${hh} * * ${dow}`;
}

function shellQuote(p: string): string {
  // Cron treats the rest of the line as the command. Single-quote the path so
  // spaces don't break parsing; escape any embedded single quotes.
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));
}

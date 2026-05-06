// Windows analogue of scheduler.ts. Uses Task Scheduler via schtasks.exe.
//
// Status shape mirrors the macOS module so BackupPanel can render one UI:
//   { kind: "not_installed" }                            — task absent
//   { kind: "loaded"; pid; lastExitCode }                — task registered;
//                                                          pid > 0 ⇒ "Status:
//                                                          Running" (we use 1
//                                                          as a sentinel since
//                                                          schtasks doesn't
//                                                          expose the PID).
//                                                          pid === null ⇒ idle.
//   { kind: "unsupported" }                              — schtasks unavailable.
//
// schtasks is part of every supported Windows install (System32) so the
// "unsupported" branch should only fire on bizarre stripped installs.

import { Command } from "@tauri-apps/plugin-shell";
import type { ScheduleSpec } from "./generateScripts";

export const WIN_TASK_NAME = "ai.skillsafe.backup";

export type WinScheduleStatus =
  | { kind: "not_installed" }
  | { kind: "loaded"; pid: number | null; lastExitCode: number | null }
  | { kind: "unsupported" };

export async function winGetStatus(): Promise<WinScheduleStatus> {
  let out;
  try {
    out = await Command.create("schtasks", [
      "/Query",
      "/TN",
      WIN_TASK_NAME,
      "/FO",
      "LIST",
      "/V",
    ]).execute();
  } catch {
    return { kind: "unsupported" };
  }
  if (out.code !== 0) return { kind: "not_installed" };
  const status = /^\s*Status:\s+(\S+)/im.exec(out.stdout)?.[1] ?? "";
  const lastResult = /^\s*Last Result:\s+(-?\d+)/im.exec(out.stdout)?.[1];
  const running = /^Running$/i.test(status);
  return {
    kind: "loaded",
    pid: running ? 1 : null,
    lastExitCode: lastResult !== undefined ? parseInt(lastResult, 10) : null,
  };
}

export interface WinInstallOptions {
  scriptPath: string;
  schedule: ScheduleSpec;
}

// schtasks /D weekday codes. Index matches the 0=Sun … 6=Sat convention used
// in ScheduleSpec.weekdays.
const WEEKDAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export async function winInstall(opts: WinInstallOptions): Promise<void> {
  // Best-effort delete first. /F on /Create overwrites only if the task is
  // already present in the same form; deleting first avoids "ERROR: The task
  // XML contains a value which is incorrectly formatted or out of range" when
  // schtasks rejects /F edge cases (e.g. switching DAILY ↔ WEEKLY).
  await Command.create("schtasks", ["/Delete", "/TN", WIN_TASK_NAME, "/F"])
    .execute()
    .catch(() => null);

  const tr =
    `powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "${opts.scriptPath}"`;
  const hh = String(clamp(opts.schedule.hour, 0, 23)).padStart(2, "0");
  const mm = String(clamp(opts.schedule.minute, 0, 59)).padStart(2, "0");
  const days = (opts.schedule.weekdays ?? []).filter((d) => d >= 0 && d <= 6);
  const args = [
    "/Create",
    "/TN",
    WIN_TASK_NAME,
    "/TR",
    tr,
    "/ST",
    `${hh}:${mm}`,
    "/F",
  ];
  if (days.length === 0) {
    args.push("/SC", "DAILY");
  } else {
    args.push("/SC", "WEEKLY", "/D", days.map((d) => WEEKDAY_CODES[d]).join(","));
  }
  const out = await Command.create("schtasks", args).execute();
  if (out.code !== 0) {
    throw new Error(
      `schtasks /Create failed (${out.code}): ${out.stderr || out.stdout}`,
    );
  }
}

export async function winUninstall(): Promise<{ removed: boolean }> {
  const out = await Command.create("schtasks", [
    "/Delete",
    "/TN",
    WIN_TASK_NAME,
    "/F",
  ]).execute();
  if (out.code === 0) return { removed: true };
  // Treat "task not found" as already-removed.
  const text = `${out.stdout}\n${out.stderr}`;
  if (/cannot find|does not exist|specified file/i.test(text)) {
    return { removed: true };
  }
  throw new Error(
    `schtasks /Delete failed (${out.code}): ${out.stderr || out.stdout}`,
  );
}

export async function winRunNow(): Promise<void> {
  const out = await Command.create("schtasks", [
    "/Run",
    "/TN",
    WIN_TASK_NAME,
  ]).execute();
  if (out.code !== 0) {
    throw new Error(
      `schtasks /Run failed (${out.code}): ${out.stderr || out.stdout}`,
    );
  }
}

export interface WinDiagnosticResult {
  taskName: string;
  scriptPath: string | null;
  scriptExists: boolean | null;
  queryCode: number;
  queryOutput: string;
}

export async function winDiagnose(opts: {
  scriptPath?: string;
  exists?: (p: string) => Promise<boolean>;
}): Promise<WinDiagnosticResult> {
  const scriptExists =
    opts.scriptPath && opts.exists ? await opts.exists(opts.scriptPath) : null;
  const query = await Command.create("schtasks", [
    "/Query",
    "/TN",
    WIN_TASK_NAME,
    "/FO",
    "LIST",
    "/V",
  ])
    .execute()
    .catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
  return {
    taskName: WIN_TASK_NAME,
    scriptPath: opts.scriptPath ?? null,
    scriptExists,
    queryCode: query.code ?? -1,
    queryOutput: (query.stdout || query.stderr || "").trim(),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));
}

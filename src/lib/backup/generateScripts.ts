import { atomicWrite, ensureDir, safeReadDir, type FsAdapter } from "../fs";
import {
  MACOS_PLIST,
  MACOS_SH,
  README_MAC,
  README_WIN,
  WINDOWS_PS1,
  WINDOWS_REGISTER_PS1,
} from "./scriptTemplates";

export type BackupPlatform = "macos" | "windows";

export interface ScheduleSpec {
  hour: number; // 0-23
  minute: number; // 0-59
  // null/undefined = run every day at <hour>:<minute>; otherwise only on the
  // listed weekdays (0=Sunday … 6=Saturday). Empty array means daily.
  weekdays?: number[] | null;
}

export const DEFAULT_SCHEDULE: ScheduleSpec = { hour: 12, minute: 15, weekdays: null };

export interface GenerateScriptsOptions {
  fs: FsAdapter;
  joiner: { join: (...parts: string[]) => Promise<string> };
  platform: BackupPlatform;
  home: string;
  destination: string;
  outDir: string;
  label?: string;
  schedule?: ScheduleSpec;
}

export interface GeneratedFile {
  path: string;
  bytes: number;
}

export interface GenerateScriptsResult {
  outDir: string;
  platform: BackupPlatform;
  files: GeneratedFile[];
}

const DEFAULT_LABEL = "ai.skillsafe.backup";

export async function generateScripts(
  opts: GenerateScriptsOptions,
): Promise<GenerateScriptsResult> {
  const label = opts.label ?? DEFAULT_LABEL;
  await ensureDir(opts.fs, opts.outDir);
  // Sweep any orphan *.tmp.<digits> files from previous runs. atomicWrite
  // tries direct overwrite first now and only falls back to tmp+rename when
  // that fails, so going forward this should usually be a no-op — but older
  // generations of atomicWrite always wrote a tmp and could leave orphans
  // when rename was interrupted.
  await sweepLocalTmps(opts.fs, opts.joiner, opts.outDir);
  if (opts.platform === "macos") {
    return generateMac({ ...opts, label });
  }
  return generateWindows({ ...opts, label });
}

async function sweepLocalTmps(
  fs: FsAdapter,
  joiner: { join: (...parts: string[]) => Promise<string> },
  dir: string,
): Promise<void> {
  let entries;
  try {
    entries = await safeReadDir(fs, dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (!/\.tmp\.\d+$/.test(entry.name)) continue;
    const child = await joiner.join(dir, entry.name);
    try { await fs.remove(child); } catch { /* best-effort */ }
  }
}

interface PreparedOptions extends GenerateScriptsOptions {
  label: string;
}

async function generateMac(opts: PreparedOptions): Promise<GenerateScriptsResult> {
  const scriptPath = await opts.joiner.join(opts.outDir, "claude_backup.sh");
  const plistPath = await opts.joiner.join(opts.outDir, `${opts.label}.plist`);
  const readmePath = await opts.joiner.join(opts.outDir, "README.md");
  const schedule = opts.schedule ?? DEFAULT_SCHEDULE;

  const replacements = {
    HOME: opts.home,
    DEST: opts.destination,
    LABEL: opts.label,
    SCRIPT_PATH: scriptPath,
    PLIST_PATH: plistPath,
    CALENDAR_INTERVAL: renderCalendarInterval(schedule),
  };

  const sh = substitute(MACOS_SH, replacements);
  const plist = substitute(MACOS_PLIST, replacements);
  const readme = substitute(README_MAC, replacements);

  return writeAll(opts, [
    { path: scriptPath, contents: sh },
    { path: plistPath, contents: plist },
    { path: readmePath, contents: readme },
  ]);
}

async function generateWindows(opts: PreparedOptions): Promise<GenerateScriptsResult> {
  const scriptPath = await opts.joiner.join(opts.outDir, "claude_backup.ps1");
  const registerPath = await opts.joiner.join(opts.outDir, "register-task.ps1");
  const readmePath = await opts.joiner.join(opts.outDir, "README.md");

  const replacements = {
    HOME: opts.home,
    DEST: opts.destination,
    LABEL: opts.label,
    SCRIPT_PATH: scriptPath,
    REGISTER_SCRIPT_PATH: registerPath,
  };

  const ps1 = substitute(WINDOWS_PS1, replacements);
  const register = substitute(WINDOWS_REGISTER_PS1, replacements);
  const readme = substitute(README_WIN, replacements);

  return writeAll(opts, [
    { path: scriptPath, contents: ps1 },
    { path: registerPath, contents: register },
    { path: readmePath, contents: readme },
  ]);
}

interface PendingFile {
  path: string;
  contents: string;
}

async function writeAll(
  opts: PreparedOptions,
  files: PendingFile[],
): Promise<GenerateScriptsResult> {
  const written: GeneratedFile[] = [];
  for (const f of files) {
    assertNoLeftoverPlaceholders(f.path, f.contents);
    await atomicWrite(opts.fs, f.path, f.contents);
    written.push({ path: f.path, bytes: byteLength(f.contents) });
  }
  return { outDir: opts.outDir, platform: opts.platform, files: written };
}

function substitute(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

function assertNoLeftoverPlaceholders(path: string, contents: string): void {
  const m = /{{[A-Z_]+}}/.exec(contents);
  if (m) {
    throw new Error(
      `template substitution incomplete in ${path}: missing replacement for ${m[0]}`,
    );
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

// Renders the <dict>...</dict> (or <array> of <dict>s for weekday-restricted
// schedules) that goes after <key>StartCalendarInterval</key> in the plist.
export function renderCalendarInterval(s: ScheduleSpec): string {
  const hour = clamp(s.hour, 0, 23);
  const minute = clamp(s.minute, 0, 59);
  const days = (s.weekdays ?? []).filter((d) => d >= 0 && d <= 6);
  if (days.length === 0) {
    return `<dict>\n        <key>Hour</key>\n        <integer>${hour}</integer>\n        <key>Minute</key>\n        <integer>${minute}</integer>\n    </dict>`;
  }
  // Multiple weekdays => an array of <dict>s, one per day.
  const items = days
    .map(
      (d) =>
        `        <dict>\n            <key>Hour</key>\n            <integer>${hour}</integer>\n            <key>Minute</key>\n            <integer>${minute}</integer>\n            <key>Weekday</key>\n            <integer>${d}</integer>\n        </dict>`,
    )
    .join("\n");
  return `<array>\n${items}\n    </array>`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// Per-machine app-state directory. The bash-flow backup manifest
// (LAST_BACKUP.json) and its run-sentinel (LAST_BACKUP.run) both live here
// so that they're tied to *this* machine's most recent run rather than to
// whichever machine last touched the shared cloud-synced backup folder.
//
// Layout (chosen to align with existing log-file locations):
//   macOS:   ~/Library/Application Support/skillsafe-app/
//   Windows: %LOCALAPPDATA%\skillsafe-app\
//   Linux:   ~/.local/state/skillsafe-app/   (XDG state — matches Linux log path)

import { type as osType } from "@tauri-apps/plugin-os";
import type { BackupPlatform } from "./generateScripts";

export const SENTINEL_FILENAME = "LAST_BACKUP.run";

// Pulled out of BackupPanel.tsx so the BackupBrowser (which needs to compute
// the same app-state paths) doesn't have to re-implement the detection.
// Trust @tauri-apps/plugin-os when it answers, but never silently fall
// through to "macos" — on Linux the Tauri webview occasionally reports an
// unexpected value or the invoke throws before the plugin is wired up, and
// the macOS default would route the install handler into launchctl, which
// spawns to ENOENT on Linux. Cross-check with navigator.userAgent/platform
// so we land on the correct branch even when osType() is unhappy.
export function detectPlatform(): BackupPlatform {
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

interface Joiner {
  join: (...parts: string[]) => Promise<string>;
}

export async function appStateDir(
  platform: BackupPlatform,
  home: string,
  joiner: Joiner,
): Promise<string> {
  if (platform === "windows") {
    return joiner.join(home, "AppData", "Local", "skillsafe-app");
  }
  if (platform === "linux") {
    return joiner.join(home, ".local", "state", "skillsafe-app");
  }
  return joiner.join(home, "Library", "Application Support", "skillsafe-app");
}

export async function manifestPath(
  platform: BackupPlatform,
  home: string,
  joiner: Joiner,
): Promise<string> {
  const dir = await appStateDir(platform, home, joiner);
  return joiner.join(dir, "LAST_BACKUP.json");
}

export async function sentinelPath(
  platform: BackupPlatform,
  home: string,
  joiner: Joiner,
): Promise<string> {
  const dir = await appStateDir(platform, home, joiner);
  return joiner.join(dir, SENTINEL_FILENAME);
}

// Sentinel file contents are 3 lines: started_at, finished_at, exit_code.
// All times are unix seconds. Parsing is intentionally lenient — the file is
// written by a shell/PowerShell trap, and we want the app to recover even if
// the script crashed mid-write.
export interface RunSentinel {
  startedAt: number;
  finishedAt: number;
  exitCode: number;
}

export function parseSentinel(text: string): RunSentinel | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const startedAt = Number(lines[0]);
  const finishedAt = Number(lines[1]);
  const exitCode = Number(lines[2]);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || !Number.isFinite(exitCode)) {
    return null;
  }
  return { startedAt, finishedAt, exitCode };
}

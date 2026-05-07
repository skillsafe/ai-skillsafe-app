// Thin wrappers around @tauri-apps/plugin-updater so the rest of the app can
// drive checks/downloads/installs without depending on Tauri APIs directly.
// All Tauri imports are confined to this file (DI seam, same pattern as
// src/lib/tauriAdapters.ts).
//
// Linux note: we ship Linux as `.deb` only — Tauri's updater can't apply a
// `.deb` patch in place (and we no longer ship AppImage), so version.json /
// latest.json never carry `linux-*` keys. The plugin's `check()` would then
// throw "None of the fallback platforms `[linux-...]` were found". On Linux
// we skip the plugin entirely, fetch version.json ourselves, and surface a
// `ManualUpdate` sentinel that routes the install path to the download page.

import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { type as osType } from "@tauri-apps/plugin-os";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

export interface UpdateProgress {
  phase: "downloading" | "installing" | "done";
  downloadedBytes: number;
  totalBytes: number | null;
}

export type ProgressHandler = (p: UpdateProgress) => void;

export interface ManualUpdate {
  __manual: true;
  version: string;
  body: string;
  date?: string;
  downloadPageUrl: string;
}

export type CheckResult = Update | ManualUpdate | null;

export function isManualUpdate(u: unknown): u is ManualUpdate {
  return !!u && typeof u === "object" && (u as ManualUpdate).__manual === true;
}

const VERSION_JSON_URL = "https://app.skillsafe.ai/version.json";
const DOWNLOAD_PAGE_URL = "https://app.skillsafe.ai/";

// Convert a Tauri DownloadEvent stream into our uniform UpdateProgress shape.
// Exported for unit tests; not used directly by the orchestrator.
export function makeDownloadEventHandler(onProgress: ProgressHandler): (e: DownloadEvent) => void {
  let downloaded = 0;
  let total: number | null = null;
  return (event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      downloaded = 0;
      onProgress({ phase: "downloading", downloadedBytes: 0, totalBytes: total });
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress({ phase: "downloading", downloadedBytes: downloaded, totalBytes: total });
    } else if (event.event === "Finished") {
      onProgress({ phase: "installing", downloadedBytes: downloaded, totalBytes: total });
    }
  };
}

function detectLinux(): boolean {
  try {
    if (osType() === "linux") return true;
  } catch {
    /* fall through to UA sniff */
  }
  if (typeof navigator !== "undefined") {
    return /linux|x11/i.test(`${navigator.userAgent || ""} ${navigator.platform || ""}`);
  }
  return false;
}

// Whether Tauri's auto-updater can apply an update in place for the running
// install. Only AppImage on Linux and the standard macOS/Windows bundles are
// auto-signed; .deb / .rpm / Snap installs need a manual download.
async function canAutoUpdate(): Promise<boolean> {
  if (!detectLinux()) return true;
  try {
    const kind = await invoke<string>("linux_installer_kind");
    return kind === "appimage";
  } catch {
    // Command not registered (older build) or invoke failed — assume the
    // install is the .deb path so we route to the manual fallback rather
    // than letting Tauri's check() error out cryptically.
    return false;
  }
}

function isNewerVersion(remote: string, current: string): boolean {
  const a = remote.split(".").map((n) => parseInt(n, 10) || 0);
  const b = current.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

async function checkForUpdateLinux(): Promise<ManualUpdate | null> {
  const [current, res] = await Promise.all([
    getVersion(),
    tauriFetch(VERSION_JSON_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
    }),
  ]);
  if (!res.ok) {
    throw new Error(`version.json: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown> | null;
  const remoteVersion = data && typeof data.version === "string" ? data.version : null;
  if (!remoteVersion) {
    throw new Error("version.json: missing 'version'");
  }
  if (!isNewerVersion(remoteVersion, current)) return null;
  return {
    __manual: true,
    version: remoteVersion,
    body: typeof data?.notes === "string" ? data.notes : "",
    date: typeof data?.pub_date === "string" ? data.pub_date : undefined,
    downloadPageUrl: DOWNLOAD_PAGE_URL,
  };
}

export async function checkForUpdate(): Promise<CheckResult> {
  // Linux .deb / .rpm installs can't auto-update (the bundler doesn't
  // auto-sign them, and Tauri's install_deb/install_rpm path can't consume
  // the AppImage tarball that the manifest does carry). Skip Tauri's check()
  // for those and fetch version.json ourselves so we can route to the
  // download page instead of surfacing a confusing dpkg/rpm install error.
  if (!(await canAutoUpdate())) {
    return await checkForUpdateLinux();
  }
  return await check();
}

export async function downloadOnly(update: CheckResult, onProgress: ProgressHandler): Promise<void> {
  if (!update) return;
  if (isManualUpdate(update)) {
    await shellOpen(update.downloadPageUrl);
    onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
    return;
  }
  await update.download(makeDownloadEventHandler(onProgress));
  onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
}

export async function installPending(update: CheckResult): Promise<void> {
  if (!update || isManualUpdate(update)) return;
  await update.install();
}

export async function installAndRelaunch(update: CheckResult, onProgress: ProgressHandler): Promise<void> {
  if (!update) return;
  if (isManualUpdate(update)) {
    await shellOpen(update.downloadPageUrl);
    onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
    return;
  }
  await update.downloadAndInstall(makeDownloadEventHandler(onProgress));
  onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
  await relaunch();
}

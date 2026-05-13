// Thin wrappers around @tauri-apps/plugin-updater so the rest of the app can
// drive checks/downloads/installs without depending on Tauri APIs directly.
// All Tauri imports are confined to this file (DI seam, same pattern as
// src/lib/tauriAdapters.ts).
//
// Linux: we don't use Tauri's plugin-updater at all. Two routes instead:
//   - AppImage (kind="appimage"): invoke the `linux_appimage_update` Rust
//     command, which shells out to bundled `appimageupdatetool` (zsync
//     delta update — writes new bytes to $APPIMAGE via atomic rename) and
//     then re-exec's from $APPIMAGE so the AppImage runtime mounts the
//     fresh SquashFS.
//   - System install (.deb/.rpm, kind="download-page"): no signed updater
//     bundle exists, so we surface a download-page sentinel and shellOpen
//     the user's browser to https://app.skillsafe.ai/.

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

// Sentinel for any Linux update where Tauri's plugin-updater is bypassed.
// `kind` decides what `installAndRelaunch` does:
//   - "appimage": invoke `linux_appimage_update` (zsync update + relaunch
//     from disk path). `downloadPageUrl` is still set as a fallback for
//     the orchestrator's error path.
//   - "download-page": shellOpen the URL. Used for .deb/.rpm/Snap installs
//     where in-place update isn't possible without root.
export interface ManualUpdate {
  __manual: true;
  kind: "appimage" | "download-page";
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

// Whether Tauri's plugin-updater (check()/downloadAndInstall()/relaunch())
// is the right driver for this install. macOS/Windows bundles are auto-
// signed and replace cleanly. Linux is always routed through our own
// runner (`linux_appimage_update` for AppImage, shellOpen for .deb/.rpm),
// so we never let Tauri's plugin-updater touch a Linux install — its
// "in-place replace + current_exe relaunch" path is what produced the
// silent loop bug.
async function useTauriUpdater(): Promise<boolean> {
  return !detectLinux();
}

// What kind of Linux install is this? Decides which ManualUpdate variant
// we emit. Defaults to "download-page" if the Rust command isn't present
// (older build / Tauri command not registered), keeping the .deb-style
// flow as a safe fallback.
async function linuxInstallerKind(): Promise<"appimage" | "system"> {
  try {
    const kind = await invoke<string>("linux_installer_kind");
    return kind === "appimage" ? "appimage" : "system";
  } catch {
    return "system";
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

async function checkForUpdateLinux(kind: "appimage" | "system"): Promise<ManualUpdate | null> {
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
    kind: kind === "appimage" ? "appimage" : "download-page",
    version: remoteVersion,
    body: typeof data?.notes === "string" ? data.notes : "",
    date: typeof data?.pub_date === "string" ? data.pub_date : undefined,
    downloadPageUrl: DOWNLOAD_PAGE_URL,
  };
}

export async function checkForUpdate(): Promise<CheckResult> {
  // Linux: bypass Tauri's plugin-updater entirely (see useTauriUpdater
  // comment above) and emit a ManualUpdate with the appropriate kind.
  if (!(await useTauriUpdater())) {
    const kind = await linuxInstallerKind();
    return await checkForUpdateLinux(kind);
  }
  return await check();
}

export async function downloadOnly(update: CheckResult, onProgress: ProgressHandler): Promise<void> {
  if (!update) return;
  if (isManualUpdate(update)) {
    // No background pre-download for manual flows: download-page would
    // open the browser too early (before the user accepted), and AppImage
    // is a single combined update+restart step that we can't split here.
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
    if (update.kind === "appimage") {
      // Bundled appimageupdatetool: zsync delta update + relaunch from
      // $APPIMAGE (handled in the Rust command, which exits the current
      // process after spawning the new one). Progress is coarse — zsync's
      // own progress isn't streamed through the IPC boundary in this
      // first cut, so we report a single "installing" tick.
      onProgress({ phase: "installing", downloadedBytes: 0, totalBytes: null });
      try {
        await invoke<string>("linux_appimage_update");
        onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
        // The Rust command schedules `app.exit(0)`; the process will be
        // gone shortly. No `relaunch()` call here — Tauri's relaunch uses
        // current_exe which resolves into the still-mounted OLD SquashFS.
        return;
      } catch (e) {
        // Fallback for older builds that pre-date the bundled
        // appimageupdatetool (the Rust command exists from v0.2.11+, the
        // bundled tool from the v0.2.11 CI change). If invoke fails OR
        // the tool isn't on disk, route the user to the download page so
        // they can still get the update — just manually.
        console.warn("[skillsafe] appimage in-place update failed, falling back to download page", e);
        await shellOpen(update.downloadPageUrl);
        onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
        return;
      }
    }
    await shellOpen(update.downloadPageUrl);
    onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
    return;
  }
  await update.downloadAndInstall(makeDownloadEventHandler(onProgress));
  onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
  await relaunch();
}

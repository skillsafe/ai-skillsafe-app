// Thin wrappers around @tauri-apps/plugin-updater so the rest of the app can
// drive checks/downloads/installs without depending on Tauri APIs directly.
// All Tauri imports are confined to this file (DI seam, same pattern as
// src/lib/tauriAdapters.ts).

import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateProgress {
  phase: "downloading" | "installing" | "done";
  downloadedBytes: number;
  totalBytes: number | null;
}

export type ProgressHandler = (p: UpdateProgress) => void;

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

export async function checkForUpdate(): Promise<Update | null> {
  return await check();
}

export async function downloadOnly(update: Update, onProgress: ProgressHandler): Promise<void> {
  await update.download(makeDownloadEventHandler(onProgress));
  onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
}

export async function installPending(update: Update): Promise<void> {
  await update.install();
}

export async function installAndRelaunch(update: Update, onProgress: ProgressHandler): Promise<void> {
  await update.downloadAndInstall(makeDownloadEventHandler(onProgress));
  onProgress({ phase: "done", downloadedBytes: 0, totalBytes: null });
  await relaunch();
}

// Picks between the two update flows (background-download vs prompt) and
// owns the in-flight `Update` handle. Designed with dependency injection so
// orchestrator logic can be unit-tested without a Tauri runtime.

import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdateProgress, ProgressHandler } from "./runner";

export interface UpdateRunner {
  checkForUpdate(): Promise<Update | null>;
  downloadOnly(update: Update, onProgress: ProgressHandler): Promise<void>;
  installPending(update: Update): Promise<void>;
  installAndRelaunch(update: Update, onProgress: ProgressHandler): Promise<void>;
}

export interface UpdateStoreView {
  getAutoUpdate(): boolean;
  getDismissedVersion(): string | null;
  setAvailableUpdate(u: { version: string; notes: string; date?: string } | null): void;
  setUpdateProgress(p: UpdateProgress | null): void;
  setUpdateError(e: string | null): void;
  setUpdateReadyToInstall(b: boolean): void;
  setShowUpdateDialog(b: boolean): void;
}

export interface OrchestratorDeps {
  runner: UpdateRunner;
  store: UpdateStoreView;
  // Logger seam — production passes console.error, tests pass a no-op.
  logError?: (msg: string, err: unknown) => void;
}

export interface Orchestrator {
  runUpdateCycle(opts?: { force?: boolean }): Promise<{ outcome: "no-update" | "downloading" | "ready" | "prompted" | "skipped" | "error" | "busy" }>;
  getPendingUpdate(): Update | null;
  installPendingNow(onProgress?: ProgressHandler): Promise<void>;
  // For the prompt flow: the dialog calls these to drive its actions.
  acceptPromptedUpdate(onProgress: ProgressHandler): Promise<void>;
  dismissPromptedUpdate(skipVersion: boolean, setDismissed: (v: string) => void): void;
}

interface InternalState {
  pendingUpdate: Update | null;
  inFlight: "checking" | "downloading" | "ready" | null;
  promptedUpdate: Update | null;
  closeHandlerUnlisten: (() => void) | null;
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { runner, store } = deps;
  const logError = deps.logError ?? ((msg, err) => console.error(msg, err));
  const state: InternalState = { pendingUpdate: null, inFlight: null, promptedUpdate: null, closeHandlerUnlisten: null };

  // Lazy-attach an install-on-quit hook only when there's a pending update.
  // Always-on `onCloseRequested` listeners can interfere with the close
  // button (Tauri awaits every handler before destroying the window), so
  // we keep the seam empty unless an install is genuinely deferred.
  async function ensureCloseHook() {
    if (state.closeHandlerUnlisten || !state.pendingUpdate) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      state.closeHandlerUnlisten = await getCurrentWindow().onCloseRequested(async (event) => {
        const pending = state.pendingUpdate;
        if (!pending) return; // nothing to install — let close proceed
        event.preventDefault();
        try {
          await pending.install();
          // install() exits the process on each platform.
        } catch (err) {
          logError("install on quit failed", err);
          await getCurrentWindow().destroy();
        }
      });
    } catch (err) {
      logError("ensureCloseHook failed", err);
    }
  }

  function clearCloseHook() {
    if (state.closeHandlerUnlisten) {
      state.closeHandlerUnlisten();
      state.closeHandlerUnlisten = null;
    }
  }

  async function runUpdateCycle(opts: { force?: boolean } = {}) {
    if (state.inFlight && !opts.force) return { outcome: "busy" as const };
    // Set a synchronous guard so two calls awaited in the same tick
    // can't both reach the downloader.
    state.inFlight = "checking";

    let update: Update | null;
    try {
      update = await runner.checkForUpdate();
    } catch (err) {
      logError("update check failed", err);
      store.setUpdateError(err instanceof Error ? err.message : String(err));
      state.inFlight = null;
      return { outcome: "error" as const };
    }

    if (!update) {
      store.setAvailableUpdate(null);
      state.inFlight = null;
      return { outcome: "no-update" as const };
    }

    const dismissed = store.getDismissedVersion();
    if (!opts.force && dismissed === update.version) {
      state.inFlight = null;
      return { outcome: "skipped" as const };
    }

    store.setAvailableUpdate({ version: update.version, notes: update.body ?? "", date: update.date });

    if (store.getAutoUpdate()) {
      state.inFlight = "downloading";
      try {
        await runner.downloadOnly(update, (p) => store.setUpdateProgress(p));
        state.pendingUpdate = update;
        state.inFlight = "ready";
        store.setUpdateReadyToInstall(true);
        store.setUpdateProgress(null);
        // Attach the install-on-quit hook now that we actually have something to install.
        void ensureCloseHook();
        return { outcome: "ready" as const };
      } catch (err) {
        logError("background download failed", err);
        store.setUpdateError(err instanceof Error ? err.message : String(err));
        store.setUpdateProgress(null);
        state.inFlight = null;
        return { outcome: "error" as const };
      }
    } else {
      state.promptedUpdate = update;
      state.inFlight = null;
      store.setShowUpdateDialog(true);
      return { outcome: "prompted" as const };
    }
  }

  function getPendingUpdate() {
    return state.pendingUpdate;
  }

  async function installPendingNow(onProgress?: ProgressHandler) {
    if (!state.pendingUpdate) return;
    clearCloseHook();
    const noop: ProgressHandler = () => {};
    // The pre-downloaded handle's download state is held in the Rust side of
    // the updater plugin and does not reliably survive across IPC calls — a
    // bare install() then throws "Update.install called before Update.download".
    // installAndRelaunch (downloadAndInstall + relaunch) keeps everything in
    // one Rust span, so the freshly-downloaded artifact is the one installed.
    // The redownload cost is one update payload at user-click time.
    await runner.installAndRelaunch(state.pendingUpdate, onProgress ?? noop);
  }

  async function acceptPromptedUpdate(onProgress: ProgressHandler) {
    if (!state.promptedUpdate) return;
    await runner.installAndRelaunch(state.promptedUpdate, onProgress);
  }

  function dismissPromptedUpdate(skipVersion: boolean, setDismissed: (v: string) => void) {
    if (skipVersion && state.promptedUpdate) {
      setDismissed(state.promptedUpdate.version);
    }
    state.promptedUpdate = null;
    store.setShowUpdateDialog(false);
  }

  return { runUpdateCycle, getPendingUpdate, installPendingNow, acceptPromptedUpdate, dismissPromptedUpdate };
}


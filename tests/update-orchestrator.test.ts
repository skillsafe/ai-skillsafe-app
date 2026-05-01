import { describe, it, expect, beforeEach } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";
import { createOrchestrator, type UpdateRunner, type UpdateStoreView } from "../src/lib/update/orchestrator";
import type { ProgressHandler, UpdateProgress } from "../src/lib/update/runner";

function makeStub(version = "0.2.0", body = "Notes"): Update {
  return {
    version,
    body,
    date: "2026-04-25T00:00:00Z",
    download: async () => {},
    install: async () => {},
    downloadAndInstall: async () => {},
    close: async () => {},
  } as unknown as Update;
}

interface StoreSpy extends UpdateStoreView {
  state: {
    autoUpdate: boolean;
    dismissed: string | null;
    available: { version: string; notes: string; date?: string } | null;
    progress: UpdateProgress | null;
    error: string | null;
    ready: boolean;
    showDialog: boolean;
  };
}

function makeStore(autoUpdate: boolean, dismissed: string | null = null): StoreSpy {
  const state = {
    autoUpdate,
    dismissed,
    available: null as { version: string; notes: string; date?: string } | null,
    progress: null as UpdateProgress | null,
    error: null as string | null,
    ready: false,
    showDialog: false,
  };
  return {
    state,
    getAutoUpdate: () => state.autoUpdate,
    getDismissedVersion: () => state.dismissed,
    setAvailableUpdate: (u) => { state.available = u; },
    setUpdateProgress: (p) => { state.progress = p; },
    setUpdateError: (e) => { state.error = e; },
    setUpdateReadyToInstall: (b) => { state.ready = b; },
    setShowUpdateDialog: (b) => { state.showDialog = b; },
  };
}

interface RunnerCounts {
  download: number;
  install: number;
  downloadAndInstall: number;
}

function makeRunner(update: Update | null, downloadDelayMs = 0): { runner: UpdateRunner; counts: RunnerCounts } {
  const counts: RunnerCounts = { download: 0, install: 0, downloadAndInstall: 0 };
  const runner: UpdateRunner = {
    checkForUpdate: async () => update,
    downloadOnly: async (_u: Update, onProgress: ProgressHandler) => {
      counts.download++;
      onProgress({ phase: "downloading", downloadedBytes: 0, totalBytes: 100 });
      if (downloadDelayMs > 0) await new Promise((r) => setTimeout(r, downloadDelayMs));
      onProgress({ phase: "downloading", downloadedBytes: 100, totalBytes: 100 });
      onProgress({ phase: "installing", downloadedBytes: 100, totalBytes: 100 });
    },
    installPending: async () => { counts.install++; },
    installAndRelaunch: async () => { counts.downloadAndInstall++; },
  };
  return { runner, counts };
}

describe("orchestrator runUpdateCycle", () => {
  let logged: Array<{ msg: string; err: unknown }>;
  beforeEach(() => { logged = []; });
  const logError = (msg: string, err: unknown) => { logged.push({ msg, err }); };

  it("returns no-update when checker returns null", async () => {
    const store = makeStore(true);
    const { runner } = makeRunner(null);
    const orch = createOrchestrator({ runner, store, logError });
    const r = await orch.runUpdateCycle();
    expect(r.outcome).toBe("no-update");
    expect(store.state.available).toBeNull();
  });

  it("auto-update ON: downloads in background, sets ready flag", async () => {
    const store = makeStore(true);
    const upd = makeStub("0.2.0");
    const { runner, counts } = makeRunner(upd);
    const orch = createOrchestrator({ runner, store, logError });
    const r = await orch.runUpdateCycle();
    expect(r.outcome).toBe("ready");
    expect(counts.download).toBe(1);
    expect(store.state.ready).toBe(true);
    expect(store.state.available?.version).toBe("0.2.0");
    expect(orch.getPendingUpdate()).toBe(upd);
  });

  it("auto-update OFF: opens prompt dialog, does not download", async () => {
    const store = makeStore(false);
    const { runner, counts } = makeRunner(makeStub("0.2.0"));
    const orch = createOrchestrator({ runner, store, logError });
    const r = await orch.runUpdateCycle();
    expect(r.outcome).toBe("prompted");
    expect(counts.download).toBe(0);
    expect(store.state.showDialog).toBe(true);
  });

  it("skips when dismissed version matches available", async () => {
    const store = makeStore(true, "0.2.0");
    const { runner, counts } = makeRunner(makeStub("0.2.0"));
    const orch = createOrchestrator({ runner, store, logError });
    const r = await orch.runUpdateCycle();
    expect(r.outcome).toBe("skipped");
    expect(counts.download).toBe(0);
  });

  it("force=true overrides dismissed version", async () => {
    const store = makeStore(true, "0.2.0");
    const { runner, counts } = makeRunner(makeStub("0.2.0"));
    const orch = createOrchestrator({ runner, store, logError });
    const r = await orch.runUpdateCycle({ force: true });
    expect(r.outcome).toBe("ready");
    expect(counts.download).toBe(1);
  });

  it("idempotency: a second call while downloading returns busy without re-downloading", async () => {
    const store = makeStore(true);
    const { runner, counts } = makeRunner(makeStub("0.2.0"), 50);
    const orch = createOrchestrator({ runner, store, logError });
    const first = orch.runUpdateCycle();
    const second = await orch.runUpdateCycle();
    expect(second.outcome).toBe("busy");
    await first;
    expect(counts.download).toBe(1);
  });

  it("propagates check errors via store and returns error outcome", async () => {
    const store = makeStore(true);
    const runner: UpdateRunner = {
      checkForUpdate: async () => { throw new Error("network down"); },
      downloadOnly: async () => {},
      installPending: async () => {},
      installAndRelaunch: async () => {},
    };
    const orch = createOrchestrator({ runner, store, logError });
    const r = await orch.runUpdateCycle();
    expect(r.outcome).toBe("error");
    expect(store.state.error).toBe("network down");
  });

  it("dismissPromptedUpdate with skipVersion=true persists the version", async () => {
    const store = makeStore(false);
    const { runner } = makeRunner(makeStub("0.3.0"));
    const orch = createOrchestrator({ runner, store, logError });
    await orch.runUpdateCycle();
    let saved: string | null = null;
    orch.dismissPromptedUpdate(true, (v) => { saved = v; });
    expect(saved).toBe("0.3.0");
    expect(store.state.showDialog).toBe(false);
  });
});

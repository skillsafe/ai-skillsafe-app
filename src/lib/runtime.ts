interface TauriGlobal {
  __TAURI_INTERNALS__?: unknown;
}

export function isTauriRuntime(): boolean {
  return !!(globalThis as typeof globalThis & TauriGlobal).__TAURI_INTERNALS__;
}

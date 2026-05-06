import { appDataDir, join } from "@tauri-apps/api/path";
import { ensureDir } from "../fs";
import { tauriFs, tauriJoiner } from "../tauriAdapters";
import type { HistoryDeps } from "./store";

let cached: Promise<HistoryDeps> | null = null;

export function getHistoryDeps(): Promise<HistoryDeps> {
  if (!cached) {
    cached = (async () => {
      const base = await appDataDir();
      const root = await join(base, "edit-history");
      await ensureDir(tauriFs, root);
      return { fs: tauriFs, joiner: tauriJoiner, root };
    })();
  }
  return cached;
}

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { tauriFs, tauriJoiner, tauriPaths } from "../tauriAdapters";
import { createFeedClient, type FeedClient } from "./client";

// App-singleton feed client. Created lazily on first use so the boot path
// doesn't pay for it on tools that don't engage the shield.

let cached: FeedClient | null = null;

export function getTauriFeedClient(): FeedClient {
  if (cached) return cached;
  cached = createFeedClient({
    fs: tauriFs,
    pj: tauriJoiner,
    homeDir: () => tauriPaths.homeDir(),
    fetch: async (url: string) => {
      const res = await tauriFetch(url);
      const text = await res.text();
      return { status: res.status, text };
    },
  });
  return cached;
}

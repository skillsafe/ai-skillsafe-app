import { createCliAuthSession, pollCliAuthSession, getAccount, SkillSafeError } from "./client";
import type { CloudAccount } from "./types";

const KEY_STORAGE = "skill-manager.skillsafeApiKey";

type LocalStorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const browser = globalThis as { localStorage?: LocalStorageLike };

export function loadApiKey(): string | null {
  return browser.localStorage?.getItem(KEY_STORAGE) ?? null;
}

export function storeApiKey(key: string): void {
  browser.localStorage?.setItem(KEY_STORAGE, key);
}

export function clearApiKey(): void {
  browser.localStorage?.removeItem(KEY_STORAGE);
}

/**
 * Run the CLI device flow.
 *
 * Calls `onAuthUrl` exactly once with the URL to open in the user's browser
 * (the caller is responsible for opening it via Tauri's shell plugin). Then
 * polls every `intervalMs` until the session is approved (returning the api
 * key), the session expires, or the abort signal fires.
 */
export async function runDeviceFlow(args: {
  onAuthUrl: (url: string) => void;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { onAuthUrl, intervalMs = 2000, signal } = args;
  const { data: session } = await createCliAuthSession({ signal });
  onAuthUrl(session.login_url);
  const expiresAt = Date.now() + session.expires_in * 1000;
  while (true) {
    if (signal?.aborted) throw new SkillSafeError("invalid_request", "Sign-in cancelled", 0);
    if (Date.now() > expiresAt) throw new SkillSafeError("invalid_request", "Sign-in session expired", 0);
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const { data } = await pollCliAuthSession(session.session_id, { signal });
      if (data.status === "approved" && data.api_key) return data.api_key;
    } catch (e) {
      // 410 Gone is returned when the session expires server-side — surface as a clean expiry.
      if (e instanceof SkillSafeError && e.status === 410) {
        throw new SkillSafeError("invalid_request", "Sign-in session expired", 410);
      }
      throw e;
    }
  }
}

export async function fetchAccount(apiKey: string, signal?: AbortSignal): Promise<CloudAccount> {
  const { data } = await getAccount(apiKey, { signal });
  return data;
}

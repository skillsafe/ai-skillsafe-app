import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeExists, sha256Hex } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import {
  FALLBACK_ENVELOPE,
  feedEnvelopeSchema,
  type FeedEnvelope,
  type FeedName,
  type FeedPayload,
} from "./types";

// Verifier hook. v1 ships with the digest verifier below; swapping in a real
// signature check (minisign, ed25519, etc.) means replacing this function in
// the deps. Keep the interface stable so PR-0.1 is a one-file change.
export type FeedVerifier = (envelope: FeedEnvelope) => Promise<VerifyResult>;
export interface VerifyResult { ok: boolean; reason?: string }

export interface FeedClientDeps {
  fs: FsAdapter;
  pj: PathJoiner;
  homeDir: () => Promise<string>;
  fetch: (url: string) => Promise<{ status: number; text: string }>;
  now?: () => number;
  url?: string;
  /** Override the on-disk cache root (test hook). */
  cacheRoot?: string;
  /** Override verifier — defaults to digest-only. */
  verify?: FeedVerifier;
}

export interface FeedClient {
  /** Returns the currently active envelope (cached or just-fetched). */
  envelope: () => Promise<FeedEnvelope>;
  /** Convenience accessor for one payload. */
  load: <N extends FeedName>(name: N) => Promise<FeedPayload<N>>;
  /** Force a refresh, bypassing TTL. Returns the new envelope or null on failure. */
  refresh: () => Promise<FeedEnvelope | null>;
}

const DEFAULT_URL = "https://app.skillsafe.ai/feeds/rules.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function createFeedClient(deps: FeedClientDeps): FeedClient {
  const now = deps.now ?? (() => Date.now());
  const url = deps.url ?? DEFAULT_URL;
  const verify = deps.verify ?? digestVerifier;
  let inMemory: { envelope: FeedEnvelope; fetchedAt: number } | null = null;

  async function cachePath(): Promise<string> {
    const root = deps.cacheRoot ?? (await deps.pj.join(await deps.homeDir(), ".skillsafe", "cache"));
    await ensureDir(deps.fs, root);
    return deps.pj.join(root, "rules.json");
  }

  async function readCache(): Promise<{ envelope: FeedEnvelope; fetchedAt: number } | null> {
    try {
      const path = await cachePath();
      if (!(await safeExists(deps.fs, path))) return null;
      const raw = await deps.fs.readTextFile(path);
      const parsed = JSON.parse(raw) as { fetchedAt: number; envelope: unknown };
      const envelope = feedEnvelopeSchema.parse(parsed.envelope);
      return { envelope, fetchedAt: parsed.fetchedAt };
    } catch {
      // Corrupt cache → ignore and refetch. Better than crashing the boot.
      return null;
    }
  }

  async function writeCache(envelope: FeedEnvelope, fetchedAt: number): Promise<void> {
    const path = await cachePath();
    await atomicWrite(deps.fs, path, JSON.stringify({ fetchedAt, envelope }));
  }

  async function fetchAndStore(): Promise<FeedEnvelope | null> {
    try {
      const res = await deps.fetch(url);
      if (res.status !== 200) return null;
      const parsed = feedEnvelopeSchema.parse(JSON.parse(res.text));
      const v = await verify(parsed);
      if (!v.ok) {
        console.warn("[feeds] verify failed:", v.reason);
        return null;
      }
      const fetchedAt = now();
      inMemory = { envelope: parsed, fetchedAt };
      await writeCache(parsed, fetchedAt).catch(() => undefined);
      return parsed;
    } catch (err) {
      console.warn("[feeds] fetch failed:", err);
      return null;
    }
  }

  async function envelope(): Promise<FeedEnvelope> {
    if (inMemory && now() - inMemory.fetchedAt < CACHE_TTL_MS) return inMemory.envelope;
    const disk = await readCache();
    if (disk && now() - disk.fetchedAt < CACHE_TTL_MS) {
      inMemory = disk;
      return disk.envelope;
    }
    const fresh = await fetchAndStore();
    if (fresh) return fresh;
    // Network/verify failed but we have a stale-but-valid cache → use it
    // (stale-on-fail). Better than the empty fallback when rules are merely
    // expired but a known good copy is on disk.
    if (disk) {
      inMemory = disk;
      return disk.envelope;
    }
    return FALLBACK_ENVELOPE;
  }

  async function load<N extends FeedName>(name: N): Promise<FeedPayload<N>> {
    const env = await envelope();
    return env.feeds[name];
  }

  async function refresh(): Promise<FeedEnvelope | null> {
    return fetchAndStore();
  }

  return { envelope, load, refresh };
}

/**
 * Canonical JSON encoding of the feeds object — sorted keys, no whitespace.
 * Used by both the builder script (to compute payload_digest) and the
 * verifier (to recompute it). Top-level feed keys are already fixed by the
 * Zod schema, but each payload object is normalized recursively so the digest
 * is stable regardless of insertion order.
 */
export function canonicalFeeds(feeds: FeedEnvelope["feeds"]): string {
  return JSON.stringify(sortKeys(feeds));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const digestVerifier: FeedVerifier = async (envelope) => {
  const computed = await sha256Hex(canonicalFeeds(envelope.feeds));
  if (computed !== envelope.payload_digest) {
    return { ok: false, reason: `digest mismatch (expected ${envelope.payload_digest}, got ${computed})` };
  }
  return { ok: true };
};

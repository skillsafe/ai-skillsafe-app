import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { createFeedClient, canonicalFeeds } from "../src/lib/feeds/client";
import { FALLBACK_ENVELOPE, type FeedEnvelope } from "../src/lib/feeds/types";
import { sha256Hex } from "../src/lib/fs";
import { nodeFs, nodeJoiner, makeTmp, rmrf } from "./_helpers";

async function makeEnvelope(overrides: Partial<FeedEnvelope["feeds"]> = {}): Promise<FeedEnvelope> {
  const feeds: FeedEnvelope["feeds"] = {
    "toxic-skills": {
      version: "test-1",
      block_rules: ["reverse_shell_*"],
      quarantine_rules: ["inducement_*"],
      ...overrides["toxic-skills"],
    },
    "mcp-blocklist": {
      version: "test-1",
      entries: [],
      ...overrides["mcp-blocklist"],
    },
    "secrets-paths": {
      version: "test-1",
      globs: [],
      ...overrides["secrets-paths"],
    },
  };
  return {
    schema: 1,
    generated_at: "2026-05-20T00:00:00.000Z",
    payload_digest: await sha256Hex(canonicalFeeds(feeds)),
    feeds,
  };
}

describe("feeds client", () => {
  it("fetches, verifies digest, caches to disk", async () => {
    const tmp = await makeTmp("feeds");
    try {
      const envelope = await makeEnvelope();
      let fetched = 0;
      const client = createFeedClient({
        fs: nodeFs,
        pj: nodeJoiner,
        homeDir: async () => tmp,
        cacheRoot: tmp,
        fetch: async () => {
          fetched++;
          return { status: 200, text: JSON.stringify(envelope) };
        },
      });

      const got = await client.envelope();
      expect(got.feeds["toxic-skills"].block_rules).toEqual(["reverse_shell_*"]);
      expect(fetched).toBe(1);

      const cached = JSON.parse(await fsp.readFile(path.join(tmp, "rules.json"), "utf8"));
      expect(cached.envelope.payload_digest).toBe(envelope.payload_digest);
    } finally {
      await rmrf(tmp);
    }
  });

  it("reuses cache within TTL without refetching", async () => {
    const tmp = await makeTmp("feeds");
    try {
      const envelope = await makeEnvelope();
      let fetched = 0;
      const fixedNow = 1_700_000_000_000;
      const client = createFeedClient({
        fs: nodeFs,
        pj: nodeJoiner,
        homeDir: async () => tmp,
        cacheRoot: tmp,
        now: () => fixedNow,
        fetch: async () => {
          fetched++;
          return { status: 200, text: JSON.stringify(envelope) };
        },
      });

      await client.envelope();
      await client.envelope();
      await client.envelope();
      expect(fetched).toBe(1);
    } finally {
      await rmrf(tmp);
    }
  });

  it("falls back to stale cache when fetch fails", async () => {
    const tmp = await makeTmp("feeds");
    try {
      const envelope = await makeEnvelope();
      // Seed a stale cache (1 year old).
      await fsp.writeFile(
        path.join(tmp, "rules.json"),
        JSON.stringify({ fetchedAt: 0, envelope }),
      );
      const client = createFeedClient({
        fs: nodeFs,
        pj: nodeJoiner,
        homeDir: async () => tmp,
        cacheRoot: tmp,
        now: () => Date.now(),
        fetch: async () => ({ status: 503, text: "" }),
      });

      const got = await client.envelope();
      expect(got.feeds["toxic-skills"].version).toBe("test-1");
    } finally {
      await rmrf(tmp);
    }
  });

  it("returns fallback envelope when nothing usable is available", async () => {
    const tmp = await makeTmp("feeds");
    try {
      const client = createFeedClient({
        fs: nodeFs,
        pj: nodeJoiner,
        homeDir: async () => tmp,
        cacheRoot: tmp,
        fetch: async () => ({ status: 500, text: "" }),
      });
      const got = await client.envelope();
      expect(got).toEqual(FALLBACK_ENVELOPE);
    } finally {
      await rmrf(tmp);
    }
  });

  it("rejects envelopes with bad digest", async () => {
    const tmp = await makeTmp("feeds");
    try {
      const envelope = await makeEnvelope();
      const tampered = { ...envelope, payload_digest: "0".repeat(64) };
      const client = createFeedClient({
        fs: nodeFs,
        pj: nodeJoiner,
        homeDir: async () => tmp,
        cacheRoot: tmp,
        fetch: async () => ({ status: 200, text: JSON.stringify(tampered) }),
      });
      const got = await client.envelope();
      // Bad digest → fetch rejected → no cache → fallback returned.
      expect(got).toEqual(FALLBACK_ENVELOPE);
    } finally {
      await rmrf(tmp);
    }
  });

  it("recovers from corrupt cache file by refetching", async () => {
    const tmp = await makeTmp("feeds");
    try {
      await fsp.writeFile(path.join(tmp, "rules.json"), "not valid json");
      const envelope = await makeEnvelope();
      const client = createFeedClient({
        fs: nodeFs,
        pj: nodeJoiner,
        homeDir: async () => tmp,
        cacheRoot: tmp,
        fetch: async () => ({ status: 200, text: JSON.stringify(envelope) }),
      });
      const got = await client.envelope();
      expect(got.payload_digest).toBe(envelope.payload_digest);
    } finally {
      await rmrf(tmp);
    }
  });

  it("load() returns the requested payload", async () => {
    const tmp = await makeTmp("feeds");
    try {
      const envelope = await makeEnvelope();
      const client = createFeedClient({
        fs: nodeFs,
        pj: nodeJoiner,
        homeDir: async () => tmp,
        cacheRoot: tmp,
        fetch: async () => ({ status: 200, text: JSON.stringify(envelope) }),
      });
      const toxic = await client.load("toxic-skills");
      expect(toxic.block_rules).toEqual(["reverse_shell_*"]);
    } finally {
      await rmrf(tmp);
    }
  });
});

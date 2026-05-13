#!/usr/bin/env node
// Generate non-English locale JSONs from src/i18n/locales/en.json using DeepL.
//
// Usage:
//   DEEPL_API_KEY=... node scripts/mt-translate.mjs            # all targets
//   DEEPL_API_KEY=... node scripts/mt-translate.mjs es fr      # subset
//
// Re-running is cheap: a hash of each source string is cached in
// scripts/.mt-cache.json so unchanged keys aren't re-translated.
// Curly-brace placeholders ({var}, {count}) are wrapped in XML tags
// (tag_handling=xml) so DeepL preserves them.
//
// Set DEEPL_API_HOST=https://api-free.deepl.com for the Free tier
// (defaults to the Pro endpoint).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOCALES_DIR = resolve(ROOT, "src/i18n/locales");
const CACHE_FILE = resolve(__dirname, ".mt-cache.json");

const SUPPORTED = ["es", "fr", "de", "zh-CN", "ja"];
const DEEPL_CODE = { es: "ES", fr: "FR", de: "DE", "zh-CN": "ZH", ja: "JA" };

const ENDPOINT = (process.env.DEEPL_API_HOST || "https://api.deepl.com") + "/v2/translate";
const KEY = process.env.DEEPL_API_KEY;

if (!KEY) {
  console.error("DEEPL_API_KEY is required.");
  process.exit(1);
}

const argTargets = process.argv.slice(2).filter((x) => !x.startsWith("-"));
const targets = argTargets.length > 0 ? argTargets : SUPPORTED;
for (const t of targets) {
  if (!SUPPORTED.includes(t)) {
    console.error(`Unsupported target: ${t}`);
    process.exit(1);
  }
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, key, out);
    } else if (typeof v === "string") {
      out[key] = v;
    }
  }
  return out;
}

function unflatten(flat) {
  const out = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!(p in cur) || typeof cur[p] !== "object") cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
  }
  return out;
}

function hashString(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

// Wrap {placeholders} in <ph> tags so DeepL leaves them untouched.
function wrap(s) {
  return s.replace(/\{(\w+)\}/g, (_, name) => `<ph name="${name}"/>`);
}
function unwrap(s) {
  return s
    .replace(/<ph name="(\w+)"\s*\/>/g, (_, name) => `{${name}}`)
    .replace(/<ph name="(\w+)"\s*><\/ph>/g, (_, name) => `{${name}}`);
}

async function translateBatch(strings, target) {
  const wrapped = strings.map(wrap);
  const body = new URLSearchParams();
  for (const w of wrapped) body.append("text", w);
  body.append("source_lang", "EN");
  body.append("target_lang", DEEPL_CODE[target]);
  body.append("tag_handling", "xml");
  body.append("preserve_formatting", "1");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepL ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.translations.map((t) => unwrap(t.text));
}

const enRaw = JSON.parse(readFileSync(resolve(LOCALES_DIR, "en.json"), "utf8"));
const enFlat = flatten(enRaw);
const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};

for (const target of targets) {
  console.log(`\n▶ ${target}`);
  const existingPath = resolve(LOCALES_DIR, `${target}.json`);
  const existingRaw = existsSync(existingPath)
    ? JSON.parse(readFileSync(existingPath, "utf8"))
    : {};
  const existing = flatten(existingRaw);
  const targetCache = cache[target] || {};

  // Decide which keys need translation: anything where the source hash
  // changed, or the cache has no entry, or the target file is missing the key.
  const todoKeys = [];
  for (const [k, v] of Object.entries(enFlat)) {
    const sourceHash = hashString(v);
    const cached = targetCache[k];
    const hasOutput = typeof existing[k] === "string" && existing[k] !== "";
    if (!cached || cached.hash !== sourceHash || !hasOutput) todoKeys.push(k);
  }
  console.log(`  ${todoKeys.length} key(s) to translate (of ${Object.keys(enFlat).length})`);

  // Chunk into batches of 50 to stay under DeepL's per-request limits.
  const CHUNK = 50;
  const next = { ...existing };
  for (let i = 0; i < todoKeys.length; i += CHUNK) {
    const batch = todoKeys.slice(i, i + CHUNK);
    const sources = batch.map((k) => enFlat[k]);
    const translated = await translateBatch(sources, target);
    batch.forEach((k, idx) => {
      next[k] = translated[idx];
      targetCache[k] = { hash: hashString(enFlat[k]) };
    });
    console.log(`  · batch ${Math.floor(i / CHUNK) + 1}: +${batch.length}`);
  }

  // Drop keys removed from English to keep the locale file in sync.
  for (const k of Object.keys(next)) {
    if (!(k in enFlat)) {
      delete next[k];
      delete targetCache[k];
    }
  }

  writeFileSync(existingPath, JSON.stringify(unflatten(next), null, 2) + "\n");
  cache[target] = targetCache;
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
  console.log(`  ✓ wrote ${existingPath}`);
}

console.log("\nDone.");

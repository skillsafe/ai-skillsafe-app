import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type {
  ApiEnvelope,
  CliAuthPoll,
  CliAuthSession,
  CloudAccount,
  CloudShareLink,
  CloudSkill,
  DownloadManifest,
  FileManifestEntry,
} from "./types";

// Production API. The Tauri build hits this directly via plugin-http; the
// browser dev build hits Vite's /v1 proxy (vite.config.ts) which forwards to
// this URL with the right Origin so api.skillsafe.ai's CORS check passes.
export const SKILLSAFE_BASE_URL = "https://api.skillsafe.ai";

interface BrowserGlobal {
  __TAURI_INTERNALS__?: unknown;
  location?: { origin: string };
}
const browserGlobal = globalThis as BrowserGlobal;
const isTauri = !!browserGlobal.__TAURI_INTERNALS__;

// In Tauri: route through plugin-http (Rust process, no CORS).
// In browser: use the native fetch, and let the dev proxy strip CORS.
const httpFetch: typeof fetch = isTauri ? (tauriFetch as unknown as typeof fetch) : fetch.bind(globalThis);
const apiBase: string = isTauri ? SKILLSAFE_BASE_URL : (browserGlobal.location?.origin ?? SKILLSAFE_BASE_URL);

export class SkillSafeError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

type FetchBody = NonNullable<RequestInit["body"]>;

interface RequestOpts {
  apiKey?: string | null;
  query?: Record<string, string | number | undefined>;
  body?: FetchBody | object | null;
  signal?: AbortSignal;
  baseUrl?: string;
}

async function request<T>(
  method: string,
  path: string,
  opts: RequestOpts = {},
): Promise<{ data: T; meta: ApiEnvelope<T>["meta"] }> {
  const base = opts.baseUrl ?? apiBase;
  const url = new URL(path, base);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let body: FetchBody | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body && typeof opts.body === "object") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await httpFetch(url, { method, headers, body, signal: opts.signal });
  // Some endpoints (downloads, share download) return raw bytes; callers handle those directly.
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    if (!res.ok) throw new SkillSafeError("internal_error", `${res.status} ${res.statusText}`, res.status);
    throw new SkillSafeError("invalid_request", `Expected JSON, got ${ct}`, res.status);
  }
  const env = (await res.json()) as ApiEnvelope<T>;
  if (!env.ok || !res.ok) {
    const code = env.error?.code ?? "internal_error";
    const message = env.error?.message ?? `${res.status} ${res.statusText}`;
    throw new SkillSafeError(code, message, res.status);
  }
  return { data: env.data as T, meta: env.meta };
}

export async function rawDownload(path: string, opts: RequestOpts = {}): Promise<Uint8Array> {
  const base = opts.baseUrl ?? apiBase;
  const url = new URL(path, base);
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await httpFetch(url, { method: "GET", headers, signal: opts.signal });
  if (!res.ok) throw new SkillSafeError("internal_error", `${res.status} ${res.statusText}`, res.status);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// ---------- Auth (device flow) ----------

export function createCliAuthSession(opts: RequestOpts = {}) {
  return request<CliAuthSession>("POST", "/v1/auth/cli", opts);
}

export function pollCliAuthSession(sessionId: string, opts: RequestOpts = {}) {
  return request<CliAuthPoll>("GET", `/v1/auth/cli/${encodeURIComponent(sessionId)}`, opts);
}

// ---------- Account ----------

export function getAccount(apiKey: string, opts: RequestOpts = {}) {
  return request<CloudAccount>("GET", "/v1/account", { ...opts, apiKey });
}

// ---------- Search ----------

export interface SearchParams {
  q?: string;
  category?: string;
  namespace?: string;
  sort?: string;
  limit?: number;
  page?: number;
  cursor?: string;
}

export function searchSkills(params: SearchParams, opts: RequestOpts = {}) {
  return request<CloudSkill[]>("GET", "/v1/skills/search", { ...opts, query: { ...params } });
}

// Lists every skill owned by the authenticated user (including private ones,
// which /v1/skills/search hides). The response has the same CloudSkill shape
// plus extra owner-only fields (visibility, status, is_owner, active_share_count).
export function listAccountSkills(apiKey: string, opts: RequestOpts = {}) {
  return request<CloudSkill[]>("GET", "/v1/account/skills", { ...opts, apiKey });
}

export interface SkillVersion {
  version_id: string;
  version: string;
  tree_hash?: string;
  changelog?: string | null;
  archive_size_bytes?: number;
  yanked?: boolean;
  saved_at?: string;
}

export interface ScanReport {
  report_id: string;
  report_type: string; // "publisher" | "consumer" | …
  scanner_version?: string;
  ruleset_version?: string;
  findings_summary?: string; // JSON string of finding objects
  findings_count?: number;
  clean?: boolean;
  bom_summary?: string; // JSON string {total_files_scanned, capability_count, risk_surface}
  submitted_at?: string;
}

export interface SkillVersionDetail {
  version_id: string;
  skill_id: string;
  version: string;
  tree_hash?: string;
  changelog?: string | null;
  archive_size_bytes?: number;
  yanked?: boolean;
  saved_at?: string;
  files?: Array<{ file_path: string; file_hash: string; file_size_bytes: number }>;
  scan_reports?: ScanReport[];
  verifications?: Array<{ verdict?: string; verified_at?: string; [k: string]: unknown }>;
}

// Detailed metadata for a single published version, including scan reports.
export function getSkillVersion(
  ns: string,
  name: string,
  version: string,
  apiKey?: string | null,
  opts: RequestOpts = {},
) {
  return request<SkillVersionDetail>(
    "GET",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    { ...opts, apiKey: apiKey ?? undefined },
  );
}

// Returns published versions for a skill, newest first.
export function listSkillVersions(
  ns: string,
  name: string,
  apiKey?: string | null,
  opts: RequestOpts = {},
) {
  return request<SkillVersion[]>(
    "GET",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/versions`,
    { ...opts, apiKey: apiKey ?? undefined, query: { limit: 20 } },
  );
}

// ---------- Skill metadata ----------

export function getSkill(ns: string, name: string, apiKey?: string | null, opts: RequestOpts = {}) {
  return request<CloudSkill>(
    "GET",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`,
    { ...opts, apiKey: apiKey ?? undefined },
  );
}

// ---------- Save ----------
//
// The live API expects multipart form data with:
//   - metadata: JSON containing `version` (required), `file_manifest: [{path,
//     hash, size}]`, plus optional description/category/tags/changelog/etc.
//   - file_<n>: each individual file's bytes, with the multipart filename set
//     to the file's relative path (the server matches by name to manifest
//     entries).
//   - scan_report (optional): JSON string from a CLI scan run.
//
// The OpenAPI spec shows a single `archive` zip; that's stale. See
// api/src/routes/skills.ts:241 for the real handler.

export interface SaveSkillMetadata {
  version: string;
  description?: string;
  category?: string;
  tags?: string[];
  changelog?: string;
  github_repo_url?: string;
  file_manifest: FileManifestEntry[];
}

export interface SaveSkillFile {
  path: string;
  bytes: Uint8Array;
}

export async function saveSkill(
  apiKey: string,
  ns: string,
  name: string,
  files: SaveSkillFile[],
  metadata: SaveSkillMetadata,
  opts: RequestOpts = {},
) {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  files.forEach((f, idx) => {
    const slice = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer;
    // The server keys files by their multipart `filename`, not the field name.
    form.append(`file_${idx}`, new Blob([slice], { type: "application/octet-stream" }), f.path);
  });
  return request<{ skill_id: string; version_id: string; version: string; name_display?: string }>(
    "POST",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`,
    { ...opts, apiKey, body: form },
  );
}

// ---------- Owner management ----------

// Soft-delete an entire skill. Server-side this also revokes share links and
// reclaims storage; locally the caller should refresh the cloud listing.
export function deleteSkill(apiKey: string, ns: string, name: string, opts: RequestOpts = {}) {
  return request<{ deleted: boolean; skill_id?: string }>(
    "DELETE",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`,
    { ...opts, apiKey },
  );
}

// Yank a single version (still downloadable for installs already pinning it
// but hidden from default resolution). Requires email-verified accounts.
export function yankSkillVersion(
  apiKey: string,
  ns: string,
  name: string,
  version: string,
  reason?: string,
  opts: RequestOpts = {},
) {
  return request<{ yanked: boolean }>(
    "POST",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/yank`,
    { ...opts, apiKey, body: { reason: reason ?? "" } },
  );
}

// Pin a specific version as the "current" — affects default install / search
// surfacing without removing other versions.
export function setCurrentVersion(
  apiKey: string,
  ns: string,
  name: string,
  version: string,
  opts: RequestOpts = {},
) {
  return request<{ current_version: string }>(
    "POST",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/current-version`,
    { ...opts, apiKey, body: { version } },
  );
}

export function starSkill(apiKey: string, ns: string, name: string, opts: RequestOpts = {}) {
  return request<{ starred: boolean }>(
    "POST",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/star`,
    { ...opts, apiKey, body: {} },
  );
}

export function unstarSkill(apiKey: string, ns: string, name: string, opts: RequestOpts = {}) {
  return request<{ starred: boolean }>(
    "DELETE",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/star`,
    { ...opts, apiKey },
  );
}

// ---------- Share ----------

export interface CreateShareLinkBody {
  visibility?: "private" | "public";
  expires_in?: "1d" | "7d" | "30d" | "never";
}

export function createShareLink(
  apiKey: string,
  ns: string,
  name: string,
  version: string,
  body: CreateShareLinkBody = {},
  opts: RequestOpts = {},
) {
  return request<CloudShareLink>(
    "POST",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/share`,
    { ...opts, apiKey, body },
  );
}

// Listing returns one row per share link that the caller created for a skill.
// The `:version` segment is required by the server's path but the response
// covers every version of the skill — see api/src/services/skills.ts:1088.
export interface ShareLinkListItem {
  share_id: string;
  version_id: string;
  version: string;
  visibility: "private" | "public";
  allow_reshare: boolean;
  access_count: number;
  expires_at: string | null;
  revoked: boolean;
  created_at: string;
}

export function listShareLinks(
  apiKey: string,
  ns: string,
  name: string,
  version: string,
  opts: RequestOpts = {},
) {
  return request<ShareLinkListItem[]>(
    "GET",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/shares`,
    { ...opts, apiKey },
  );
}

export function revokeShareLink(apiKey: string, shareId: string, opts: RequestOpts = {}) {
  return request<{ share_id: string; revoked: boolean }>(
    "DELETE",
    `/v1/share/${encodeURIComponent(shareId)}`,
    { ...opts, apiKey },
  );
}

// ---------- Download ----------

export function downloadShareManifest(shareId: string, opts: RequestOpts = {}) {
  return request<DownloadManifest>(
    "GET",
    `/v1/share/${encodeURIComponent(shareId)}/download`,
    opts,
  );
}

export function downloadSkillManifest(
  ns: string,
  name: string,
  version: string,
  apiKey?: string | null,
  opts: RequestOpts = {},
) {
  return request<DownloadManifest>(
    "GET",
    `/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/download/${encodeURIComponent(version)}`,
    { ...opts, apiKey: apiKey ?? undefined },
  );
}

export function downloadBlob(hash: string, apiKey?: string | null, opts: RequestOpts = {}): Promise<Uint8Array> {
  return rawDownload(`/v1/blobs/${encodeURIComponent(hash)}`, { ...opts, apiKey: apiKey ?? undefined });
}

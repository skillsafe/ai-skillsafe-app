// Types mirroring https://api.skillsafe.ai (see web/public/openapi.json).
// Only the fields we actually consume in the UI are typed strictly; the rest
// are tolerated via index signatures so a server-side addition won't break us.

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta?: {
    request_id?: string;
    pagination?: {
      has_more?: boolean;
      next_cursor?: string | null;
      total_count?: number;
      page?: number;
      per_page?: number;
      total_pages?: number;
    };
    [k: string]: unknown;
  };
}

// Field names match the live API (api/src/routes/skills.ts), not the
// stale OpenAPI doc at web/public/openapi.json. Notably the live API uses
// `latest_version` (not `current_version`) and `install_count` (not
// `download_count`).
export interface CloudSkill {
  skill_id: string;
  namespace: string;
  name: string;
  name_display?: string;
  description?: string | null;
  category?: string | null;
  tags?: string[] | string | null;
  visibility?: "private" | "public";
  latest_version?: string;
  install_count?: number;
  star_count?: number;
  verification_count?: number;
  scan_clean?: boolean;
  scan_findings_count?: number;
  github_repo_url?: string | null;
  github_stars?: number | null;
  archive_size_bytes?: number;
  // Owner-only fields surfaced by /v1/account/skills (cast to string by the
  // server in some environments — coerce when reading).
  active_share_count?: number | string;
  status?: string;
  is_owner?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface DownloadManifestFile {
  path: string;
  hash: string;
  size: number;
}

export interface DownloadManifest {
  format: "files";
  tree_hash: string;
  version_id: string;
  skill_id: string;
  files: DownloadManifestFile[];
  namespace?: string;
  name?: string;
  version?: string;
}

export interface FileManifestEntry {
  path: string;
  hash: string;        // sha256:<hex>
  size: number;
}

export interface CloudShareLink {
  share_id: string;
  skill_id: string;
  version: string;
  visibility: "private" | "public";
  expires_at: string | null;
  created_at: string;
  download_count: number;
}

export interface CloudAccount {
  account_id: string;
  namespace: string;
  email: string;
  email_verified: boolean;
  tier: "free" | "pro" | "enterprise";
  avatar_url?: string;
  created_at?: string;
}

// Live API returns { session_id, login_url, expires_in } where expires_in is
// seconds-from-now. The OpenAPI spec at web/public/openapi.json shows
// auth_url/expires_at — the actual route in api/src/routes/auth.ts is the
// source of truth.
export interface CliAuthSession {
  session_id: string;
  login_url: string;
  expires_in: number;
}

// Polling: pending until the user approves in the browser, then the row is
// deleted on first read so the api_key is one-time-use. A 410 (expired) comes
// back as an error envelope, not a status field.
export interface CliAuthPoll {
  status: "pending" | "approved";
  api_key?: string;
  account_id?: string;
  username?: string;
  namespace?: string;
}

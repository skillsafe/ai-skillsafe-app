import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeExists } from "../fs";
import type { PathResolverDeps } from "../paths";
import type { PathJoiner } from "../artifacts/skill";
import type { ConfigScope, ProjectSettingsTier } from "./types";
import {
  hooksSchema,
  permissionsSchema,
  type Hooks,
  type Permissions,
} from "./schemas";

// One settings.json document, parsed into the keys we know about plus a
// `_rest` blob holding everything else. We always re-serialize from
// `{ ...rest, ...known }` so unknown top-level keys (statusLine, theme,
// effortLevel, etc.) round-trip unchanged.
export interface SettingsDoc {
  path: string;
  exists: boolean;
  permissions: Permissions;
  hooks: Hooks;
  env: Record<string, string>;
  rest: Record<string, unknown>;
  // mtime at load time, so the save path can detect on-disk drift.
  mtimeMs: number | null;
}

export async function settingsPath(
  pj: PathJoiner,
  paths: PathResolverDeps,
  scope: ConfigScope,
  projectRoot: string | null,
  tier: ProjectSettingsTier,
): Promise<string | null> {
  if (scope === "global") {
    const home = await paths.homeDir();
    return pj.join(home, ".claude", "settings.json");
  }
  if (!projectRoot) return null;
  const file = tier === "shared" ? "settings.json" : "settings.local.json";
  return pj.join(projectRoot, ".claude", file);
}

export async function loadSettings(
  fs: FsAdapter,
  path: string,
): Promise<SettingsDoc> {
  if (!(await safeExists(fs, path))) {
    return {
      path,
      exists: false,
      permissions: {},
      hooks: {},
      env: {},
      rest: {},
      mtimeMs: null,
    };
  }
  const raw = await fs.readTextFile(path);
  let parsed: Record<string, unknown> = {};
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Malformed JSON — surface as an empty doc with rest holding nothing.
      // The editor's "Raw JSON" fallback (added in slice 4) is the escape
      // hatch for hand-recovering a broken file.
      parsed = {};
    }
  }
  const { permissions, hooks, env, rest } = splitKnown(parsed);
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await fs.stat(path)).mtimeMs;
  } catch {
    /* ignore */
  }
  return { path, exists: true, permissions, hooks, env, rest, mtimeMs };
}

interface SaveOptions {
  permissions?: Permissions;
  hooks?: Hooks;
  env?: Record<string, string>;
}

// Saves a *patch* on top of the loaded doc. Anything not mentioned in `patch`
// is preserved from `doc` (or, for unknown keys, `doc.rest`).
export async function saveSettings(
  fs: FsAdapter,
  _pj: PathJoiner,
  doc: SettingsDoc,
  patch: SaveOptions,
): Promise<SettingsDoc> {
  const next: Record<string, unknown> = { ...doc.rest };
  const permissions = patch.permissions ?? doc.permissions;
  const hooks = patch.hooks ?? doc.hooks;
  const env = patch.env ?? doc.env;

  if (permissions && Object.keys(permissions).length > 0) {
    next.permissions = pruneEmpty(permissions);
  }
  if (hooks && Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  }
  if (env && Object.keys(env).length > 0) {
    next.env = env;
  }

  // Validate before writing so a bug elsewhere can't put garbage on disk.
  if (next.permissions) permissionsSchema.parse(next.permissions);
  if (next.hooks) hooksSchema.parse(next.hooks);

  const dir = parentDir(doc.path);
  if (dir) await ensureDir(fs, dir);

  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  await atomicWrite(fs, doc.path, serialized);
  return loadSettings(fs, doc.path);
}

function splitKnown(parsed: Record<string, unknown>): {
  permissions: Permissions;
  hooks: Hooks;
  env: Record<string, string>;
  rest: Record<string, unknown>;
} {
  const { permissions, hooks, env, ...rest } = parsed;
  const permResult = permissionsSchema.safeParse(permissions ?? {});
  const hookResult = hooksSchema.safeParse(hooks);
  const envOut: Record<string, string> = {};
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === "string") envOut[k] = v;
    }
  }
  return {
    permissions: permResult.success ? permResult.data : {},
    hooks: hookResult.success ? hookResult.data ?? {} : {},
    env: envOut,
    rest,
  };
}

// Drop empty arrays and undefined fields so we don't write `"allow": []` into
// a freshly-saved file. Keeps diffs minimal when a user opens-and-saves a
// previously-clean settings.json.
function pruneEmpty(p: Permissions): Permissions {
  const out: Permissions = {};
  for (const key of ["allow", "deny", "ask"] as const) {
    const arr = p[key];
    if (arr && arr.length > 0) out[key] = arr;
  }
  if (p.defaultMode) out.defaultMode = p.defaultMode;
  for (const [k, v] of Object.entries(p)) {
    if (k === "allow" || k === "deny" || k === "ask" || k === "defaultMode") continue;
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

// Master store — folder-of-files canonical aggregation across tools.
//
// Layout (under <masterRoot>):
//   manifest.json
//   memory/global/<tool>--<filename>            (e.g. claude--CLAUDE.md)
//   memory/projects/<encoded-cwd>/<tool>--<filename>
//   mcp/global/<tool>--<server-name>.json
//   mcp/projects/<encoded-cwd>/<tool>--<server-name>.json
//
// Future PRs add hooks/, permissions/, keybindings/, transcripts/. The
// folder is human-diffable on purpose — users are expected to `git init`
// it and version-control the master tree themselves.

import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeExists, safeReadDir, sha256Hex } from "../fs";
import { loadMcp, saveMcp } from "../configs/mcp";
import { loadSettings, saveSettings } from "../configs/settingsJson";
import { loadKeybindings, saveKeybindings } from "../configs/keybindings";
import type {
  Hooks,
  Keybinding,
  McpServer,
  Permissions,
} from "../configs/schemas";
import type { PathJoiner } from "../artifacts/skill";
import type { PathResolverDeps } from "../paths";
import { getHome } from "../paths";
import type { InventoryItem, StateCategory, WorkbenchScope } from "../inventory/types";
import {
  parseMemoryFor,
  renderMemoryFor,
  MEMORY_TRANSFER_TARGETS,
} from "../translate/memory";
import type { Manifest, MasterEntry, MasterSource } from "./types";
import { MANIFEST_FILE, MANIFEST_VERSION } from "./types";

export const DEFAULT_MASTER_FOLDER_NAME = "SkillSafe/master";

/**
 * Resolve the absolute master root. Precedence:
 *   1. User-specified override (Settings → Workbench master folder).
 *   2. `<backupDestination>/master` — keeps master beside snapshots so
 *      one folder pick configures both.
 *   3. `<home>/SkillSafe/master` fallback when neither is set.
 *
 * The folder isn't created here — addToMaster + saveManifest call
 * ensureDir as needed.
 */
export async function resolveMasterRoot(
  paths: PathResolverDeps,
  override: string | null,
  backupDestination?: string | null,
): Promise<string> {
  if (override && override.trim()) return override;
  if (backupDestination && backupDestination.trim()) {
    return paths.join(backupDestination, "master");
  }
  const home = await getHome(paths);
  return paths.join(home, "SkillSafe", "master");
}

// ---------- path helpers ----------

/** Encode an absolute project path into a single filesystem-safe segment. */
export function encodeProjectPath(p: string): string {
  // Mirror Claude's projects/<encoded-cwd> convention so master entries
  // can round-trip across machines that share the same project layout.
  // Drops the leading slash before encoding so the result doesn't begin
  // with a `-`.
  return p.replace(/[\/\\]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

/** Strip the trailing extension; "CLAUDE.md" → "CLAUDE", "rule.mdc" → "rule". */
function stripExt(name: string): { base: string; ext: string } {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, idx), ext: name.slice(idx) };
}

/** Sanitize a name segment to safe filename characters. */
function safeSegment(s: string): string {
  return s.replace(/[\/\\:*?"<>|]/g, "_");
}

/**
 * Compute the master-relative path for an inventory item.
 *
 * Layout: each tool gets its own subdirectory under the scope so the
 * resulting filenames stay readable in Finder / `ls`. Two tools sharing
 * a memory filename (rare in practice) end up under their own dirs and
 * never collide.
 *
 *   memory/global/<tool>/<name>
 *   memory/projects/<encoded-cwd>/<tool>/<name>
 *   mcp/global/<tool>/<name>.json
 *   mcp/projects/<encoded-cwd>/<tool>/<name>.json
 */
export function masterPathFor(item: InventoryItem): string {
  const tool = safeSegment(item.tool);
  const name = safeSegment(item.name);

  if (item.category === "memory") {
    const { ext: rawExt } = stripExt(name);
    // Default to .md when an item has no extension (e.g. .clinerules).
    const file = rawExt ? name : `${name}.md`;
    if (item.scope === "global") return `memory/global/${tool}/${file}`;
    const enc = item.projectPath ? encodeProjectPath(item.projectPath) : "_unknown";
    return `memory/projects/${enc}/${tool}/${file}`;
  }

  if (item.category === "mcp") {
    const file = `${name}.json`;
    if (item.scope === "global") return `mcp/global/${tool}/${file}`;
    const enc = item.projectPath ? encodeProjectPath(item.projectPath) : "_unknown";
    return `mcp/projects/${enc}/${tool}/${file}`;
  }

  // hooks / permissions / keybindings: each item is the whole block as
  // JSON. Same scope-aware layout as memory + mcp.
  if (
    item.category === "hooks" ||
    item.category === "permissions" ||
    item.category === "keybindings"
  ) {
    const file = `${name}.json`;
    if (item.scope === "global") return `${item.category}/global/${tool}/${file}`;
    const enc = item.projectPath ? encodeProjectPath(item.projectPath) : "_unknown";
    return `${item.category}/projects/${enc}/${tool}/${file}`;
  }

  // Future categories fall through to <category>/<tool>/<name>.
  return `${item.category}/${tool}/${name}`;
}

// ---------- manifest CRUD ----------

export async function loadManifest(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
): Promise<Manifest> {
  const path = await pj.join(masterRoot, MANIFEST_FILE);
  if (!(await safeExists(fs, path))) {
    return emptyManifest(masterRoot);
  }
  let raw = "";
  try {
    raw = await fs.readTextFile(path);
  } catch {
    return emptyManifest(masterRoot);
  }
  if (!raw.trim()) return emptyManifest(masterRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyManifest(masterRoot);
  }
  return normalizeManifest(parsed, masterRoot);
}

export async function saveManifest(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  manifest: Manifest,
): Promise<void> {
  await ensureDir(fs, masterRoot);
  const path = await pj.join(masterRoot, MANIFEST_FILE);
  const out: Manifest = {
    ...manifest,
    version: MANIFEST_VERSION,
    masterRoot,
    generatedAt: Date.now(),
  };
  // Stable key order keeps the manifest git-friendly across runs.
  const json = JSON.stringify(out, manifestReplacer, 2) + "\n";
  await atomicWrite(fs, path, json);
}

function emptyManifest(masterRoot: string): Manifest {
  return {
    version: MANIFEST_VERSION,
    masterRoot,
    generatedAt: 0,
    entries: [],
  };
}

function normalizeManifest(parsed: unknown, masterRoot: string): Manifest {
  if (!parsed || typeof parsed !== "object") return emptyManifest(masterRoot);
  const obj = parsed as Record<string, unknown>;
  const entries = Array.isArray(obj.entries) ? obj.entries : [];
  const safe: MasterEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.category !== "string" ||
      typeof r.masterPath !== "string" ||
      typeof r.canonicalHash !== "string" ||
      !Array.isArray(r.sources)
    ) {
      continue;
    }
    safe.push({
      id: r.id,
      category: r.category as StateCategory,
      masterPath: r.masterPath,
      canonicalHash: r.canonicalHash,
      sources: r.sources
        .map((s) => normalizeSource(s))
        .filter((s): s is MasterSource => s !== null),
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
      notes: typeof r.notes === "string" ? r.notes : undefined,
    });
  }
  return {
    version: MANIFEST_VERSION,
    masterRoot,
    generatedAt: typeof obj.generatedAt === "number" ? obj.generatedAt : 0,
    entries: safe,
  };
}

function normalizeSource(raw: unknown): MasterSource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.tool !== "string" ||
    (r.scope !== "global" && r.scope !== "project") ||
    typeof r.absPath !== "string" ||
    typeof r.lastSyncedHash !== "string" ||
    typeof r.lastSyncedAt !== "number"
  ) {
    return null;
  }
  return {
    tool: r.tool,
    scope: r.scope as WorkbenchScope,
    projectPath: typeof r.projectPath === "string" ? r.projectPath : null,
    absPath: r.absPath,
    lastSyncedHash: r.lastSyncedHash,
    lastSyncedAt: r.lastSyncedAt,
  };
}

function manifestReplacer(_key: string, value: unknown): unknown {
  // Ensure entries are sorted by masterPath so manifests are diff-stable.
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof (value[0] as { masterPath?: unknown }).masterPath === "string") {
      const copy = [...(value as MasterEntry[])];
      copy.sort((a, b) => a.masterPath.localeCompare(b.masterPath));
      return copy;
    }
  }
  return value;
}

// ---------- payload file IO ----------

async function joinAll(pj: PathJoiner, root: string, rel: string): Promise<string> {
  const parts = rel.split("/").filter(Boolean);
  return pj.join(root, ...parts);
}

function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

/**
 * Render the canonical payload for a category. Memory items write the raw
 * markdown body; MCP items write pretty-printed JSON of the server config.
 */
function renderPayload(item: InventoryItem): string {
  if (item.category === "memory") {
    const body = isObjectWithKey(item.payload, "body") ? String(item.payload.body) : "";
    return body;
  }
  // mcp + future categories: JSON of the payload.
  return JSON.stringify(item.payload, null, 2) + "\n";
}

export async function writeMasterPayload(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  item: InventoryItem,
): Promise<{ masterPath: string; absMasterPath: string; canonicalHash: string }> {
  const masterPath = masterPathFor(item);
  const abs = await joinAll(pj, masterRoot, masterPath);
  const dir = parentDir(abs);
  if (dir) await ensureDir(fs, dir);
  const body = renderPayload(item);
  await atomicWrite(fs, abs, body);
  const canonicalHash = await sha256Hex(body);
  return { masterPath, absMasterPath: abs, canonicalHash };
}

export async function readMasterPayload(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  masterPath: string,
): Promise<string | null> {
  const abs = await joinAll(pj, masterRoot, masterPath);
  if (!(await safeExists(fs, abs))) return null;
  try {
    return await fs.readTextFile(abs);
  } catch {
    return null;
  }
}

export async function deleteMasterPayload(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  masterPath: string,
): Promise<void> {
  const abs = await joinAll(pj, masterRoot, masterPath);
  if (!(await safeExists(fs, abs))) return;
  // Surface the error rather than swallow it — a silent failure here
  // leaves the payload as an orphan in the master folder while the
  // manifest entry is gone.
  await fs.remove(abs);
}

// ---------- top-level ops ----------

export async function addToMaster(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  item: InventoryItem,
): Promise<MasterEntry> {
  const manifest = await loadManifest(fs, pj, masterRoot);
  const { masterPath, canonicalHash } = await writeMasterPayload(fs, pj, masterRoot, item);
  const now = Date.now();
  const source: MasterSource = {
    tool: item.tool,
    scope: item.scope,
    projectPath: item.projectPath,
    absPath: item.absPath,
    lastSyncedHash: item.contentHash,
    lastSyncedAt: now,
  };
  const existingIdx = manifest.entries.findIndex((e) => e.id === item.id);
  let entry: MasterEntry;
  if (existingIdx >= 0) {
    const existing = manifest.entries[existingIdx];
    // Preserve other sources; update the matching one or append it.
    const sources = [...existing.sources];
    const matchIdx = sources.findIndex(
      (s) => s.tool === source.tool && s.scope === source.scope && s.projectPath === source.projectPath,
    );
    if (matchIdx >= 0) sources[matchIdx] = source;
    else sources.push(source);
    entry = {
      ...existing,
      masterPath,
      canonicalHash,
      sources,
      updatedAt: now,
    };
    manifest.entries[existingIdx] = entry;
  } else {
    entry = {
      id: item.id,
      category: item.category,
      masterPath,
      canonicalHash,
      sources: [source],
      updatedAt: now,
    };
    manifest.entries.push(entry);
  }
  await saveManifest(fs, pj, masterRoot, manifest);
  return entry;
}

export async function removeFromMaster(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  entryId: string,
): Promise<void> {
  const manifest = await loadManifest(fs, pj, masterRoot);
  const idx = manifest.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return;
  const entry = manifest.entries[idx];
  await deleteMasterPayload(fs, pj, masterRoot, entry.masterPath);
  manifest.entries.splice(idx, 1);
  await saveManifest(fs, pj, masterRoot, manifest);
}

/**
 * Restore the master content into a single source's on-disk location.
 * Memory items overwrite the file; MCP items merge into the destination's
 * `.mcp.json` `mcpServers` map without touching siblings.
 */
export async function restoreSourceFromMaster(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  entry: MasterEntry,
  source: MasterSource,
  /** Item name (e.g. server name for MCP) — taken from the originating InventoryItem when known. */
  itemName: string,
): Promise<void> {
  const body = await readMasterPayload(fs, pj, masterRoot, entry.masterPath);
  if (body === null) {
    throw new Error(`Master payload missing: ${entry.masterPath}`);
  }
  if (entry.category === "memory") {
    const dir = parentDir(source.absPath);
    if (dir) await ensureDir(fs, dir);
    // When the source's tool differs from the entry's canonical tool
    // (the first contributor — what the master payload was authored as),
    // run the body through the cross-tool memory translator. This is
    // what lets a single canonical body fan out to claude/codex/cursor/cline
    // in their idiomatic shapes (cursor MDC frontmatter, etc.).
    const canonicalTool = canonicalMemoryTool(entry);
    const translated =
      canonicalTool && canonicalTool !== source.tool && isMemoryTransferTool(source.tool)
        ? renderMemoryFor(source.tool, parseMemoryFor(canonicalTool, body), {
            sourceName: itemName,
          })
        : body;
    await atomicWrite(fs, source.absPath, translated);
    return;
  }
  if (entry.category === "mcp") {
    const doc = await loadMcp(fs, source.absPath);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Master MCP payload is not valid JSON: ${entry.masterPath}`);
    }
    const next = doc.servers.filter((s) => s.name !== itemName);
    next.push({ name: itemName, server: payload as McpServer });
    const reloaded = doc.exists
      ? doc
      : { path: source.absPath, exists: false, servers: [], rest: {}, mtimeMs: null };
    await saveMcp(fs, reloaded, next);
    return;
  }
  if (entry.category === "hooks" || entry.category === "permissions") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`Master ${entry.category} payload is not valid JSON: ${entry.masterPath}`);
    }
    const dir = parentDir(source.absPath);
    if (dir) await ensureDir(fs, dir);
    const doc = await loadSettings(fs, source.absPath);
    if (entry.category === "hooks") {
      await saveSettings(fs, pj, doc, { hooks: parsed as Hooks });
    } else {
      await saveSettings(fs, pj, doc, { permissions: parsed as Permissions });
    }
    return;
  }
  if (entry.category === "keybindings") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`Master keybindings payload is not valid JSON: ${entry.masterPath}`);
    }
    const dir = parentDir(source.absPath);
    if (dir) await ensureDir(fs, dir);
    const obj = (parsed ?? {}) as Record<string, unknown>;
    const bindings = Array.isArray(obj.bindings) ? (obj.bindings as Keybinding[]) : [];
    const { bindings: _omit, ...rest } = obj;
    const doc = await loadKeybindings(fs, source.absPath);
    // Preserve existing rest fields by merging master's rest on top.
    await saveKeybindings(
      fs,
      { ...doc, rest: { ...doc.rest, ...rest } },
      bindings,
    );
    return;
  }
  throw new Error(`Restore not implemented for category ${entry.category}`);
}

// ---------- drift / index helpers ----------

/** Look up a master entry by InventoryItem (matches by item.id). */
export function findEntryFor(manifest: Manifest, item: InventoryItem): MasterEntry | undefined {
  return manifest.entries.find((e) => e.id === item.id);
}

/** Look up the matching source row for a given inventory item. */
export function findSourceFor(entry: MasterEntry, item: InventoryItem): MasterSource | undefined {
  return entry.sources.find(
    (s) => s.tool === item.tool && s.scope === item.scope && s.projectPath === item.projectPath,
  );
}

export type MasterState =
  | { kind: "not-in-master" }
  | { kind: "in-sync"; entry: MasterEntry; source: MasterSource }
  | { kind: "drifted"; entry: MasterEntry; source: MasterSource };

export function masterStateFor(manifest: Manifest, item: InventoryItem): MasterState {
  const entry = findEntryFor(manifest, item);
  if (!entry) return { kind: "not-in-master" };
  const source = findSourceFor(entry, item);
  if (!source) return { kind: "not-in-master" };
  if (source.lastSyncedHash === item.contentHash) return { kind: "in-sync", entry, source };
  return { kind: "drifted", entry, source };
}

/** Master entries with no inventory item still on disk = "only-in-master". */
export function entriesOnlyInMaster(
  manifest: Manifest,
  inventoryIds: Set<string>,
): MasterEntry[] {
  return manifest.entries.filter((e) => !inventoryIds.has(e.id));
}

/** List the master folder's payload files, recursive. Used for orphan cleanup. */
export async function listMasterFiles(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
): Promise<string[]> {
  if (!(await safeExists(fs, masterRoot))) return [];
  const out: string[] = [];
  await walk(fs, pj, masterRoot, "", out);
  return out;
}

interface DecodedMasterPath {
  category: StateCategory | null;
  scope: WorkbenchScope | null;
  encodedProjectPath: string | null;
  tool: string | null;
  name: string;
}

/**
 * Reverse `masterPathFor`. Recovers category / scope / tool / name from
 * a master-relative path. Supports both the current layout
 *
 *   memory/global/<tool>/<name>
 *   memory/projects/<enc>/<tool>/<name>
 *   mcp/global/<tool>/<name>.json
 *   mcp/projects/<enc>/<tool>/<name>.json
 *
 * and the legacy `<tool>--<name>` filename convention so master folders
 * created before the layout change still display correctly.
 */
export function decodeMasterPath(rel: string): DecodedMasterPath {
  const parts = rel.split("/").filter(Boolean);
  const filename = parts[parts.length - 1] ?? rel;
  const out: DecodedMasterPath = {
    category: null,
    scope: null,
    encodedProjectPath: null,
    tool: null,
    name: filename,
  };
  if (parts.length === 0) return out;
  const cat = parts[0];
  if (
    cat === "memory" ||
    cat === "mcp" ||
    cat === "hooks" ||
    cat === "permissions" ||
    cat === "keybindings" ||
    cat === "transcripts"
  ) {
    out.category = cat;
  }
  if (parts[1] === "global") {
    out.scope = "global";
    // New layout: memory/global/<tool>/<name> — parts.length === 4
    if (parts.length === 4) {
      out.tool = parts[2];
      out.name = parts[3];
    }
  } else if (parts[1] === "projects") {
    out.scope = "project";
    out.encodedProjectPath = parts[2] ?? null;
    // New layout: memory/projects/<enc>/<tool>/<name> — parts.length === 5
    if (parts.length === 5) {
      out.tool = parts[3];
      out.name = parts[4];
    }
  }
  // Legacy fallback: filename uses `<tool>--<name>` form.
  if (!out.tool) {
    const idx = filename.indexOf("--");
    if (idx > 0) {
      out.tool = filename.slice(0, idx);
      out.name = filename.slice(idx + 2);
    }
  }
  // Strip MCP's .json extension so the displayed name matches the source.
  if (out.category === "mcp" && out.name.endsWith(".json")) {
    out.name = out.name.slice(0, -5);
  }
  return out;
}

/**
 * Walk every file in the master folder and synthesize an InventoryItem
 * per file. Manifest entries (when present) are joined in to recover the
 * canonical id, sources, and updatedAt; orphan files (no manifest entry)
 * still appear so the user can preview them.
 */
export async function listMasterItems(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  manifest: Manifest | null,
): Promise<InventoryItem[]> {
  const files = await listMasterFiles(fs, pj, masterRoot);
  const byPath = new Map<string, MasterEntry>();
  if (manifest) {
    for (const e of manifest.entries) byPath.set(e.masterPath, e);
  }
  const out: InventoryItem[] = [];
  for (const rel of files) {
    const entry = byPath.get(rel);
    const decoded = decodeMasterPath(rel);
    const firstSource = entry?.sources[0];
    const tool = firstSource?.tool ?? decoded.tool ?? "__master__";
    const category: StateCategory =
      entry?.category ?? decoded.category ?? "memory";
    const scope: WorkbenchScope =
      firstSource?.scope ?? decoded.scope ?? "global";
    const projectPath = firstSource?.projectPath ?? null;
    const id = entry?.id ?? `master:${rel}`;
    const absPath = await joinAll(pj, masterRoot, rel);
    let lastSeen = entry?.updatedAt ?? 0;
    if (!lastSeen) {
      try {
        lastSeen = (await fs.stat(absPath)).mtimeMs;
      } catch {
        /* ignore */
      }
    }
    out.push({
      id,
      tool,
      category,
      scope,
      projectPath,
      name: decoded.name,
      absPath,
      payload: { masterPath: rel },
      contentHash: entry?.canonicalHash ?? "",
      lastSeen,
      masterOnly: true,
    });
  }
  return out;
}

async function walk(
  fs: FsAdapter,
  pj: PathJoiner,
  root: string,
  relPrefix: string,
  out: string[],
): Promise<void> {
  const abs = relPrefix ? await joinAll(pj, root, relPrefix) : root;
  const entries = await safeReadDir(fs, abs);
  for (const e of entries) {
    // Skip the manifest at any depth — it's metadata, not user content.
    if (e.name === MANIFEST_FILE) continue;
    // Skip hidden files (.DS_Store, .gitignore, etc.).
    if (e.name.startsWith(".")) continue;
    const childRel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      await walk(fs, pj, root, childRel, out);
    } else if (e.isFile) {
      out.push(childRel);
    }
  }
}

// ---------- bind / unbind ----------

/**
 * Describe a tool location to attach as an additional source on an
 * existing master entry. `syncedHash` is set when the caller has just
 * written the canonical content to `absPath` (e.g. immediately after
 * Transfer); leave it undefined to record a "claim only" bind whose
 * masterStateFor() will report drifted until a Restore.
 */
export interface BindTarget {
  tool: string;
  scope: WorkbenchScope;
  projectPath: string | null;
  absPath: string;
  syncedHash?: string;
}

/**
 * Attach `target` to `entryId` as an additional source. Idempotent: a
 * source with the same (tool, scope, projectPath) is replaced. Returns
 * the resulting MasterSource row.
 */
export async function bindSource(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  entryId: string,
  target: BindTarget,
): Promise<MasterSource> {
  const manifest = await loadManifest(fs, pj, masterRoot);
  const idx = manifest.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error(`No master entry with id ${entryId}`);
  const entry = manifest.entries[idx];
  const now = Date.now();
  const source: MasterSource = {
    tool: target.tool,
    scope: target.scope,
    projectPath: target.projectPath,
    absPath: target.absPath,
    // "" + 0 means "bound, never synced" — masterStateFor reports drift
    // because the source's current contentHash will not match.
    lastSyncedHash: target.syncedHash ?? "",
    lastSyncedAt: target.syncedHash ? now : 0,
  };
  const sources = [...entry.sources];
  const matchIdx = sources.findIndex(
    (s) => s.tool === source.tool && s.scope === source.scope && s.projectPath === source.projectPath,
  );
  if (matchIdx >= 0) sources[matchIdx] = source;
  else sources.push(source);
  manifest.entries[idx] = { ...entry, sources, updatedAt: now };
  await saveManifest(fs, pj, masterRoot, manifest);
  return source;
}

/**
 * Remove a source row from `entryId`. Matches by (tool, scope,
 * projectPath); the destination file on disk is not touched. No-op when
 * the entry or matching source isn't found.
 */
export async function unbindSource(
  fs: FsAdapter,
  pj: PathJoiner,
  masterRoot: string,
  entryId: string,
  match: { tool: string; scope: WorkbenchScope; projectPath: string | null },
): Promise<void> {
  const manifest = await loadManifest(fs, pj, masterRoot);
  const idx = manifest.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return;
  const entry = manifest.entries[idx];
  const filtered = entry.sources.filter(
    (s) => !(s.tool === match.tool && s.scope === match.scope && s.projectPath === match.projectPath),
  );
  if (filtered.length === entry.sources.length) return;
  manifest.entries[idx] = { ...entry, sources: filtered, updatedAt: Date.now() };
  await saveManifest(fs, pj, masterRoot, manifest);
}

/**
 * The tool whose body shape master is currently storing. Used to decide
 * whether a memory restore needs cross-tool translation. Falls back to
 * the first source's tool when the entry has no notes-based override.
 */
function canonicalMemoryTool(entry: MasterEntry): string | null {
  if (entry.category !== "memory") return null;
  const first = entry.sources[0];
  return first?.tool ?? null;
}

function isMemoryTransferTool(tool: string): boolean {
  return (MEMORY_TRANSFER_TARGETS as readonly string[]).includes(tool);
}

// ---------- tiny utility ----------

function isObjectWithKey<K extends string>(
  v: unknown,
  key: K,
): v is Record<K, unknown> {
  return typeof v === "object" && v !== null && key in (v as Record<string, unknown>);
}

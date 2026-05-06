export interface FsAdapter {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
  readFile?: (path: string) => Promise<Uint8Array>;
  writeFile?: (path: string, contents: Uint8Array) => Promise<void>;
  readDir: (path: string) => Promise<DirEntry[]>;
  exists: (path: string) => Promise<boolean>;
  stat: (path: string) => Promise<{ mtimeMs: number; isFile: boolean; isDirectory: boolean; size: number }>;
  mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
  remove: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  // Used by Claude project skill installs to bridge .agents/skills/<n> →
  // .claude/skills/<n>. Optional because some adapters (mock/test) skip it.
  symlink?: (target: string, link: string) => Promise<void>;
  // Removes `path` only if it's a symlink. No-op on real files/dirs — keeps
  // uninstall from accidentally wiping user-authored .claude/skills/<n> if
  // the bridge link was never created or got replaced with real content.
  removeIfSymlink?: (path: string) => Promise<boolean>;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink?: boolean;
}

export async function safeReadDir(fs: FsAdapter, dir: string): Promise<DirEntry[]> {
  // Treat any failure as "empty directory". Symlinks pointing outside the
  // Tauri fs:scope allow list throw "forbidden path"; broken targets, denied
  // ACLs, and races all throw too — none of which should kill a directory
  // scan that's iterating other entries.
  try {
    if (!(await fs.exists(dir))) return [];
    return await fs.readDir(dir);
  } catch {
    return [];
  }
}

export async function safeExists(fs: FsAdapter, path: string): Promise<boolean> {
  // exists() throws "forbidden path" when the target canonicalizes outside
  // the fs:scope allow list (Tauri 2 plugin-fs behavior). Treat that as
  // "doesn't exist" so probe checks don't propagate failures.
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}

export async function ensureDir(fs: FsAdapter, dir: string): Promise<void> {
  if (await fs.exists(dir)) return;
  await fs.mkdir(dir, { recursive: true });
}

export async function atomicWrite(fs: FsAdapter, path: string, contents: string): Promise<void> {
  // Strategy A (preferred): direct overwrite. Tauri's writeTextFile uses
  // open(O_WRONLY|O_TRUNC|O_CREAT) under the hood, which works in-place
  // without unlinking — so it doesn't litter .tmp files inside cloud-synced
  // folders that briefly lock files during sync.
  try {
    await fs.writeTextFile(path, contents);
    return;
  } catch { /* fall through to atomic-rename strategy */ }

  // Strategy B: tmp + atomic rename. Only used when direct overwrite fails
  // (e.g. read-only quirks). POSIX rename(2) overwrites the dest atomically.
  const tmp = `${path}.tmp.${Date.now()}`;
  await fs.writeTextFile(tmp, contents);
  try {
    await fs.rename(tmp, path);
    return;
  } catch { /* try remove+rename for Windows */ }
  try {
    if (await fs.exists(path)) await fs.remove(path);
    await fs.rename(tmp, path);
    return;
  } finally {
    // Best-effort cleanup of the tmp if rename ultimately failed.
    if (await fs.exists(tmp)) {
      try { await fs.remove(tmp); } catch { /* ignore */ }
    }
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // crypto.subtle expects BufferSource; newer TS libs type Uint8Array as
  // Uint8Array<ArrayBufferLike>, which includes SharedArrayBuffer and is
  // rejected by digest()'s signature. Cast through unknown for the call.
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

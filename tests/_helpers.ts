import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { DirEntry, FsAdapter } from "../src/lib/fs";
import type { PathResolverDeps } from "../src/lib/paths";
import type { PathJoiner } from "../src/lib/artifacts/skill";

export const nodeFs: FsAdapter = {
  readTextFile: (p) => fs.readFile(p, "utf8"),
  writeTextFile: (p, c) => fs.writeFile(p, c, "utf8"),
  readFile: async (p) => new Uint8Array(await fs.readFile(p)),
  writeFile: (p, c) => fs.writeFile(p, c),
  readDir: async (p): Promise<DirEntry[]> => {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
    }));
  },
  exists: async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
  stat: async (p) => {
    const s = await fs.stat(p);
    return {
      mtimeMs: s.mtimeMs,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
    };
  },
  mkdir: async (p, opts) => {
    await fs.mkdir(p, { recursive: opts?.recursive ?? true });
  },
  remove: async (p, opts) => {
    await fs.rm(p, { recursive: opts?.recursive ?? false, force: true });
  },
  rename: (from, to) => fs.rename(from, to),
};

export const nodeJoiner: PathJoiner = {
  join: async (...parts: string[]) => path.join(...parts),
};

export function pathDeps(home: string): PathResolverDeps {
  return {
    homeDir: async () => home,
    join: async (...parts: string[]) => path.join(...parts),
  };
}

export async function makeTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix + "-"));
}

export async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

import {
  exists as fsExists,
  mkdir as fsMkdir,
  readDir as fsReadDir,
  readFile as fsReadFile,
  readTextFile as fsReadTextFile,
  remove as fsRemove,
  rename as fsRename,
  stat as fsStat,
  writeFile as fsWriteFile,
  writeTextFile as fsWriteTextFile,
} from "@tauri-apps/plugin-fs";
import { homeDir, join } from "@tauri-apps/api/path";
import type { DirEntry, FsAdapter } from "./fs";
import type { PathResolverDeps } from "./paths";
import type { PathJoiner } from "./artifacts/skill";

export const tauriFs: FsAdapter = {
  readTextFile: (p) => fsReadTextFile(p),
  writeTextFile: (p, c) => fsWriteTextFile(p, c),
  readFile: (p) => fsReadFile(p),
  writeFile: (p, c) => fsWriteFile(p, c),
  readDir: async (p): Promise<DirEntry[]> => {
    const entries = await fsReadDir(p);
    return entries.map((e) => ({
      name: e.name,
      isFile: !!e.isFile,
      isDirectory: !!e.isDirectory,
      isSymlink: !!e.isSymlink,
    }));
  },
  exists: (p) => fsExists(p),
  stat: async (p) => {
    const s = await fsStat(p);
    return {
      mtimeMs: s.mtime ? new Date(s.mtime).getTime() : 0,
      isFile: s.isFile,
      isDirectory: s.isDirectory,
      size: Number(s.size ?? 0),
    };
  },
  mkdir: async (p, opts) => {
    await fsMkdir(p, { recursive: opts?.recursive ?? true });
  },
  remove: async (p, opts) => {
    await fsRemove(p, { recursive: opts?.recursive ?? false });
  },
  rename: async (from, to) => {
    await fsRename(from, to);
  },
};

export const tauriPaths: PathResolverDeps = {
  homeDir: () => homeDir(),
  join: (...parts: string[]) => join(...parts),
};

export const tauriJoiner: PathJoiner = {
  join: (...parts: string[]) => join(...parts),
};

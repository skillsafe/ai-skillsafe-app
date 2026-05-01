import { unzipSync, zipSync } from "fflate";
import type { FsAdapter } from "../fs";
import { ensureDir } from "../fs";
import type { PathJoiner } from "../artifacts/skill";

/**
 * Recursively read every regular file under `dir` into an in-memory map of
 * relative-path → bytes. Used to pack a Claude skill bundle for upload.
 *
 * Symlinks and hidden dotfiles at the bundle root are skipped — registries
 * generally reject those, and they're never part of a clean SKILL.md bundle.
 */
async function collectFiles(
  fs: FsAdapter,
  pj: PathJoiner,
  dir: string,
  prefix = "",
): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const entries = await fs.readDir(dir);
  for (const e of entries) {
    if (e.isSymlink) continue;
    if (prefix === "" && e.name.startsWith(".")) continue;
    const child = await pj.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      const nested = await collectFiles(fs, pj, child, rel);
      Object.assign(out, nested);
    } else if (e.isFile) {
      if (fs.readFile) {
        out[rel] = await fs.readFile(child);
      } else {
        const text = await fs.readTextFile(child);
        out[rel] = new TextEncoder().encode(text);
      }
    }
  }
  return out;
}

/** Pack a skill bundle directory into a zip archive (Uint8Array). */
export async function packSkillBundle(
  fs: FsAdapter,
  pj: PathJoiner,
  bundleDir: string,
): Promise<Uint8Array> {
  const files = await collectFiles(fs, pj, bundleDir);
  return zipSync(files);
}

/**
 * Extract a zip archive into `targetDir`, creating it (and any subdirs) as
 * needed. Returns the list of relative paths written.
 *
 * Refuses entries with absolute paths or `..` segments — protects against
 * zip-slip attacks on archives downloaded from the registry.
 */
export async function extractIntoDir(
  fs: FsAdapter,
  pj: PathJoiner,
  archive: Uint8Array,
  targetDir: string,
): Promise<string[]> {
  const entries = unzipSync(archive);
  const written: string[] = [];
  await ensureDir(fs, targetDir);
  for (const [rel, bytes] of Object.entries(entries)) {
    if (rel.endsWith("/")) continue;
    if (rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) {
      throw new Error(`Refusing unsafe archive path: ${rel}`);
    }
    const segments = rel.split("/");
    let cur = targetDir;
    for (let i = 0; i < segments.length - 1; i++) {
      cur = await pj.join(cur, segments[i]);
      await ensureDir(fs, cur);
    }
    const fullPath = await pj.join(cur, segments[segments.length - 1]);
    if (fs.writeFile) {
      await fs.writeFile(fullPath, bytes);
    } else {
      await fs.writeTextFile(fullPath, new TextDecoder().decode(bytes));
    }
    written.push(rel);
  }
  return written;
}

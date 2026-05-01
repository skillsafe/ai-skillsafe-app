import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { FileManifestEntry } from "./types";
import type { SaveSkillFile } from "./client";

/**
 * Walk a Claude skill bundle directory and produce both:
 *   - the `file_manifest` (for the metadata JSON sent in the Save POST), with
 *     a sha256:<hex> hash per file matching the format the server validates
 *     against; and
 *   - the per-file byte payloads, each labeled with its relative path so the
 *     multipart Blob filename matches the manifest entry.
 *
 * Symlinks and dotfiles at the bundle root (.DS_Store, .git/, etc.) are
 * skipped; nested directories are walked recursively. Paths use forward
 * slashes regardless of host OS so the server stores them canonically.
 */
export async function collectBundleFiles(
  fs: FsAdapter,
  pj: PathJoiner,
  bundleDir: string,
): Promise<{ files: SaveSkillFile[]; manifest: FileManifestEntry[] }> {
  const files: SaveSkillFile[] = [];
  const manifest: FileManifestEntry[] = [];

  async function walk(dir: string, prefix: string) {
    const entries = await fs.readDir(dir);
    for (const e of entries) {
      if (e.isSymlink) continue;
      if (prefix === "" && e.name.startsWith(".")) continue;
      const child = await pj.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory) {
        await walk(child, rel);
      } else if (e.isFile) {
        const bytes = fs.readFile
          ? await fs.readFile(child)
          : new TextEncoder().encode(await fs.readTextFile(child));
        const hash = await sha256Bytes(bytes);
        files.push({ path: rel, bytes });
        manifest.push({ path: rel, hash, size: bytes.byteLength });
      }
    }
  }

  await walk(bundleDir, "");
  return { files, manifest };
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest accepts a BufferSource — pass the underlying ArrayBuffer slice.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", ab);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

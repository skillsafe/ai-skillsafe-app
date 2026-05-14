// I/O-coupled preview loader. Sits on top of the pure classifier in
// fileClassify.ts so live trees (AttachmentTree, RemoteAttachmentTree)
// and the BackupBrowser pane can share the same decision tree:
//
//   1. extension → image / known-binary / too-large / text
//   2. for "text": read bytes, byte-sniff, and either return decoded text
//      or downgrade to "binary"
//
// Keep this module thin — it only does FS reads + the classifier glue.
// Rendering choices stay in the components.

import {
  classifyPreviewByMeta,
  fileBasename,
  inferLanguage,
  looksLikeBinaryBytes,
  type PreviewKind,
} from "./fileClassify";

interface MinimalFs {
  stat: (path: string) => Promise<{ size: number }>;
  readFile?: (path: string) => Promise<Uint8Array>;
  readTextFile: (path: string) => Promise<string>;
}

export type PreviewLoad =
  | { kind: "image"; path: string; name: string }
  | { kind: "binary"; reason: "extension" | "bytes"; path: string; name: string; size: number }
  | { kind: "too-large"; path: string; name: string; size: number }
  | { kind: "text"; path: string; name: string; content: string; language: string; size: number };

/**
 * Classify + load a file for read-only preview. Never throws on
 * "expected" outcomes (binary, too-large, image) — those come back as
 * discriminated variants. Genuine I/O errors (file gone, permission
 * denied) still throw so the caller can surface them.
 *
 * The size guard runs before any byte read, so a 4 GB file won't be
 * pulled into memory just to be rejected.
 */
export async function loadForPreview(
  fs: MinimalFs,
  path: string,
  name = fileBasename(path),
): Promise<PreviewLoad> {
  let size = 0;
  try {
    size = (await fs.stat(path)).size;
  } catch {
    // stat() failing usually means the file is gone — let the caller
    // discover it via readTextFile below where the error message is
    // more actionable.
  }

  const preKind: PreviewKind = classifyPreviewByMeta(name, size);
  if (preKind === "image") return { kind: "image", path, name };
  if (preKind === "binary") {
    return { kind: "binary", reason: "extension", path, name, size };
  }
  if (preKind === "too-large") {
    return { kind: "too-large", path, name, size };
  }

  // Text candidate: prefer readFile so we can byte-sniff, fall back to
  // readTextFile for adapters that only expose text reads (mocks).
  if (fs.readFile) {
    const bytes = await fs.readFile(path);
    if (looksLikeBinaryBytes(bytes)) {
      return { kind: "binary", reason: "bytes", path, name, size: bytes.length };
    }
    return {
      kind: "text",
      path,
      name,
      content: new TextDecoder().decode(bytes),
      language: inferLanguage(name),
      size: bytes.length,
    };
  }
  const content = await fs.readTextFile(path);
  return {
    kind: "text",
    path,
    name,
    content,
    language: inferLanguage(name),
    size: new TextEncoder().encode(content).byteLength,
  };
}

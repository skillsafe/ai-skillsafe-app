// Bridge: MarkdownArtifact (SKILL.md + attachments on disk) → LocalScanReport.
// Reads every textual attachment in the bundle, caps total bytes, and feeds
// the canonical scanner. Binary attachments are passed in with an empty
// content string so the BOM still counts them and `binary_file` findings
// trigger off the extension list.

import type { FsAdapter } from "../fs";
import type { MarkdownArtifact, Attachment } from "../artifacts/types";
import { scanBundle } from "./envelope";
import type { LocalScanReport, ScanFileInput } from "./types";

// 4 MiB total cap across the bundle keeps a pathological skill from
// blocking the UI thread.
const MAX_BYTES = 4 * 1024 * 1024;
// 1 MiB per file. Anything larger is almost certainly a real binary that
// happens to have a text extension.
const MAX_FILE_BYTES = 1024 * 1024;

export async function scanArtifact(
  fs: FsAdapter,
  artifact: MarkdownArtifact,
): Promise<LocalScanReport> {
  const files: ScanFileInput[] = [];
  let budget = MAX_BYTES;

  const rootName = artifact.isBundle ? "SKILL.md" : basename(artifact.path);
  const rootContent = artifact.raw ?? "";
  files.push({ path: rootName, content: rootContent.slice(0, MAX_FILE_BYTES) });
  budget -= Math.min(rootContent.length, MAX_FILE_BYTES);

  if (artifact.isBundle && artifact.bundleDir) {
    const bundleDir = artifact.bundleDir;
    for await (const a of flattenAttachments(artifact.attachments)) {
      if (budget <= 0) break;
      const rel = relativeTo(bundleDir, a.path);
      if (a.size > MAX_FILE_BYTES) {
        // Pass through with empty content — binary-file extension rule and
        // BOM total_files_scanned still see it.
        files.push({ path: rel, content: "" });
        continue;
      }
      try {
        const text = await fs.readTextFile(a.path);
        const clipped = text.slice(0, Math.min(text.length, budget, MAX_FILE_BYTES));
        budget -= clipped.length;
        files.push({ path: rel, content: clipped });
      } catch {
        files.push({ path: rel, content: "" });
      }
    }
  }

  return scanBundle({ label: artifact.name, files });
}

async function* flattenAttachments(items: Attachment[]): AsyncGenerator<Attachment> {
  for (const a of items) {
    if (a.isDir) {
      if (a.children) yield* flattenAttachments(a.children);
    } else {
      yield a;
    }
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function relativeTo(root: string, path: string): string {
  const r = root.replace(/[\\/]+$/, "");
  if (path.startsWith(r)) {
    return path.slice(r.length).replace(/^[\\/]+/, "");
  }
  return basename(path);
}

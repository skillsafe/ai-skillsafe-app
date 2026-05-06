import type { FsAdapter } from "../fs";
import { safeReadDir } from "../fs";
import type { PathJoiner } from "./skill";
import type { MarkdownArtifact } from "./types";

// Resolved-ahead-of-time description of what `confirmDelete` will actually
// touch on disk for a given artifact. The confirmation modal renders one of
// three explicit messages (case 1/2/3 in the design notes) based on these
// fields, so users always see the cascade before they confirm.
export interface DeletePreview {
  // The bundle path or markdown path that will be removed first. Always
  // matches `artifact.bundleDir ?? artifact.path`.
  primaryPath: string;
  // True when `primaryPath` itself is a symlink. Listing dedupe should
  // prevent this for skill bundles, but the modal handles it defensively:
  // in that case `deleteSkillBundle` only unlinks the link — the underlying
  // bundle the symlink points at stays on disk.
  primaryIsSymlink: boolean;
  // Set when the primary is a real bundle under .agents/skills/<n> AND a
  // sibling symlink at <project>/.claude/skills/<n> exists. That symlink
  // gets removed in the same operation.
  bridgeSymlinkPath: string | null;
}

export async function resolveDeletePreview(
  fs: FsAdapter,
  pj: PathJoiner,
  artifact: MarkdownArtifact,
): Promise<DeletePreview> {
  const primaryPath = artifact.bundleDir ?? artifact.path;
  const result: DeletePreview = {
    primaryPath,
    primaryIsSymlink: false,
    bridgeSymlinkPath: null,
  };
  if (!primaryPath) return result;

  // Look up the parent dir entry to learn whether `primaryPath` is itself a
  // symlink. We rely on the existing readDir → isSymlink contract so no new
  // fs adapter capability is required.
  const sep = primaryPath.includes("\\") ? "\\" : "/";
  const segments = primaryPath.split(/[/\\]/);
  const lastSegment = segments[segments.length - 1];
  const parentDir = segments.slice(0, -1).join(sep);
  if (parentDir) {
    const entries = await safeReadDir(fs, parentDir);
    const self = entries.find((e) => e.name === lastSegment);
    if (self?.isSymlink) result.primaryIsSymlink = true;
  }

  // Cascade detection: a Claude project install at <project>/.agents/skills/<n>
  // typically has a bridge symlink at <project>/.claude/skills/<n>. When
  // present, it gets removed alongside the bundle.
  const m = primaryPath.match(/^(.*)[/\\]\.agents[/\\]skills[/\\]([^/\\]+)[/\\]?$/);
  if (m && !result.primaryIsSymlink) {
    const projectRoot = m[1];
    const name = m[2];
    const claudeSkillsDir = await pj.join(projectRoot, ".claude", "skills");
    const linkPath = await pj.join(claudeSkillsDir, name);
    const linkParentEntries = await safeReadDir(fs, claudeSkillsDir);
    const linkEntry = linkParentEntries.find((e) => e.name === name);
    if (linkEntry?.isSymlink) {
      result.bridgeSymlinkPath = linkPath;
    }
  }

  return result;
}

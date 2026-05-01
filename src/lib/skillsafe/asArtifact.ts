import type { Attachment, MarkdownArtifact } from "../artifacts/types";
import type { CloudSkill, DownloadManifestFile } from "./types";

/**
 * Adapt a CloudSkill (skillsafe.ai search hit) to the MarkdownArtifact shape
 * the local UI is built around. The body / attachments aren't known at
 * search time and are filled in lazily when the user selects the card.
 */
export function cloudSkillToArtifact(s: CloudSkill): MarkdownArtifact {
  const description = (s.description ?? "").trim();
  const tags = Array.isArray(s.tags) ? s.tags : undefined;
  const updated = s.updated_at ? Date.parse(s.updated_at) : undefined;
  return {
    id: `cloud:${s.skill_id}`,
    tool: "claude",
    scope: "global",
    type: "skill",
    name: s.name,
    // The version is rendered as a separate clickable badge in the editor
    // toolbar, so the canonical "path" stays version-free.
    path: `${s.namespace}/${s.name}`,
    isBundle: true,
    bundleDir: undefined,
    frontmatter: {
      name: s.name_display ?? s.name,
      description,
      ...(tags ? { tags } : {}),
      ...(s.category ? { category: s.category } : {}),
      ...(s.latest_version ? { version: s.latest_version } : {}),
      ...(s.visibility ? { visibility: s.visibility } : {}),
      ...(s.github_repo_url ? { github_repo_url: s.github_repo_url } : {}),
      namespace: s.namespace,
    },
    body: "",
    raw: "",
    attachments: [],
    mtimeMs: Number.isFinite(updated) ? updated : undefined,
  };
}

/**
 * Convert a downloaded skill manifest into the Attachment[] shape used by
 * the AttachmentTree component. Cloud blobs aren't local files, so `path`
 * stores the relative manifest path (display only).
 */
export function manifestToAttachments(files: DownloadManifestFile[]): Attachment[] {
  // Build a directory-aware tree.
  interface Node {
    name: string;
    path: string;
    size: number;
    isDir: boolean;
    children?: Map<string, Node>;
  }
  const root: Node = { name: "", path: "", size: 0, isDir: true, children: new Map() };

  for (const f of files) {
    const segments = f.path.split("/").filter(Boolean);
    let cur = root;
    for (let i = 0; i < segments.length; i++) {
      const isLeaf = i === segments.length - 1;
      const seg = segments[i];
      const childPath = segments.slice(0, i + 1).join("/");
      let child = cur.children!.get(seg);
      if (!child) {
        child = {
          name: seg,
          path: childPath,
          size: isLeaf ? f.size : 0,
          isDir: !isLeaf,
          children: isLeaf ? undefined : new Map(),
        };
        cur.children!.set(seg, child);
      }
      cur = child;
    }
  }

  function flatten(node: Node): Attachment[] {
    if (!node.children) return [];
    const out: Attachment[] = [];
    for (const child of node.children.values()) {
      out.push({
        name: child.name,
        path: child.path,
        size: child.size,
        isDir: child.isDir,
        children: child.isDir ? flatten(child) : undefined,
      });
    }
    return out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  return flatten(root);
}

export function findSkillMdPath(files: DownloadManifestFile[]): string | undefined {
  const direct = files.find((f) => f.path === "SKILL.md" || f.path.toLowerCase() === "skill.md");
  if (direct) return direct.path;
  const nested = files.find((f) => f.path.toLowerCase().endsWith("/skill.md"));
  return nested?.path;
}

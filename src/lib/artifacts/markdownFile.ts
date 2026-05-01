import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeReadDir, sha256Hex } from "../fs";
import { parseFrontmatter, stringifyFrontmatter } from "../frontmatter";
import type { ArtifactType, MarkdownArtifact, Scope, Tool } from "./types";
import type { PathJoiner } from "./skill";

export async function listMarkdownFiles(
  fs: FsAdapter,
  pj: PathJoiner,
  dir: string,
  tool: Tool,
  scope: Scope,
  type: ArtifactType,
  extension = ".md",
): Promise<MarkdownArtifact[]> {
  const entries = await safeReadDir(fs, dir);
  const out: MarkdownArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(extension)) continue;
    const path = await pj.join(dir, entry.name);
    out.push(await loadMarkdownFile(fs, path, tool, scope, type));
  }
  return out;
}

export async function loadMarkdownFile(
  fs: FsAdapter,
  path: string,
  tool: Tool,
  scope: Scope,
  type: ArtifactType,
): Promise<MarkdownArtifact> {
  const raw = await fs.readTextFile(path);
  const { data, body } = parseFrontmatter(raw);
  const stat = await fs.stat(path);
  const segments = path.split(/[\\/]/).filter(Boolean);
  const fileName = segments[segments.length - 1] ?? path;
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const name = (data.name as string | undefined) ?? baseName;
  return {
    id: `${tool}:${scope}:${type}:${path}`,
    tool,
    scope,
    type,
    name,
    path,
    isBundle: false,
    frontmatter: data,
    body,
    raw,
    attachments: [],
    mtimeMs: stat.mtimeMs,
    computedHash: await sha256Hex(raw),
  };
}

export async function saveMarkdownFile(
  fs: FsAdapter,
  artifact: MarkdownArtifact,
): Promise<MarkdownArtifact> {
  const next = stringifyFrontmatter(artifact.frontmatter, artifact.body);
  await ensureDir(fs, parentOf(artifact.path));
  await atomicWrite(fs, artifact.path, next);
  const stat = await fs.stat(artifact.path);
  return {
    ...artifact,
    raw: next,
    mtimeMs: stat.mtimeMs,
    computedHash: await sha256Hex(next),
  };
}

export async function deleteMarkdownFile(
  fs: FsAdapter,
  artifact: MarkdownArtifact,
): Promise<void> {
  await fs.remove(artifact.path);
}

export async function createMarkdownFile(
  fs: FsAdapter,
  pj: PathJoiner,
  dir: string,
  fileName: string,
  frontmatter: Record<string, unknown>,
  body: string,
  tool: Tool,
  scope: Scope,
  type: ArtifactType,
): Promise<MarkdownArtifact> {
  await ensureDir(fs, dir);
  const path = await pj.join(dir, fileName);
  const raw = stringifyFrontmatter(frontmatter, body);
  await atomicWrite(fs, path, raw);
  return loadMarkdownFile(fs, path, tool, scope, type);
}

function parentOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : path;
}

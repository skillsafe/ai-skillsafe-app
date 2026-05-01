import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeReadDir, sha256Hex } from "../fs";
import { parseFrontmatter, stringifyFrontmatter } from "../frontmatter";
import type { Attachment, MarkdownArtifact, Scope, Tool } from "./types";

export interface PathJoiner {
  join: (...parts: string[]) => Promise<string>;
}

export async function listSkillBundles(
  fs: FsAdapter,
  pj: PathJoiner,
  rootDir: string,
  tool: Tool,
  scope: Scope,
): Promise<MarkdownArtifact[]> {
  const entries = await safeReadDir(fs, rootDir);
  const out: MarkdownArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory && !entry.isSymlink) continue;
    const bundleDir = await pj.join(rootDir, entry.name);
    const skillFile = await pj.join(bundleDir, "SKILL.md");
    if (!(await fs.exists(skillFile))) continue;
    const artifact = await loadSkillBundle(fs, pj, bundleDir, tool, scope);
    out.push(artifact);
  }
  return out;
}

export async function loadSkillBundle(
  fs: FsAdapter,
  pj: PathJoiner,
  bundleDir: string,
  tool: Tool,
  scope: Scope,
): Promise<MarkdownArtifact> {
  const skillFile = await pj.join(bundleDir, "SKILL.md");
  const raw = await fs.readTextFile(skillFile);
  const { data, body } = parseFrontmatter(raw);
  const stat = await fs.stat(skillFile);
  const attachments = await listAttachments(fs, pj, bundleDir);
  const computedHash = await sha256Hex(raw);
  const segments = bundleDir.split(/[\\/]/).filter(Boolean);
  const name = (data.name as string | undefined) ?? segments[segments.length - 1] ?? bundleDir;
  return {
    id: `${tool}:${scope}:skill:${bundleDir}`,
    tool,
    scope,
    type: "skill",
    name,
    path: skillFile,
    isBundle: true,
    bundleDir,
    frontmatter: data,
    body,
    raw,
    attachments,
    mtimeMs: stat.mtimeMs,
    computedHash,
  };
}

async function listAttachments(
  fs: FsAdapter,
  pj: PathJoiner,
  dir: string,
  isRoot = true,
): Promise<Attachment[]> {
  const out: Attachment[] = [];
  const entries = await safeReadDir(fs, dir);
  for (const entry of entries) {
    if (isRoot && entry.name === "SKILL.md") continue;
    const path = await pj.join(dir, entry.name);
    let isDir = entry.isDirectory;
    let isFile = entry.isFile;
    if (!isDir && !isFile && entry.isSymlink) {
      try {
        const s = await fs.stat(path);
        isDir = s.isDirectory;
        isFile = s.isFile;
      } catch {
        continue;
      }
    }
    if (isFile) {
      const stat = await fs.stat(path);
      out.push({ name: entry.name, path, size: stat.size, isDir: false });
    } else if (isDir) {
      out.push({
        name: entry.name,
        path,
        size: 0,
        isDir: true,
        children: await listAttachments(fs, pj, path, false),
      });
    }
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return out;
}

export async function saveSkillBundle(
  fs: FsAdapter,
  pj: PathJoiner,
  artifact: MarkdownArtifact,
): Promise<MarkdownArtifact> {
  if (!artifact.bundleDir) throw new Error("saveSkillBundle requires bundleDir");
  await ensureDir(fs, artifact.bundleDir);
  const next = stringifyFrontmatter(artifact.frontmatter, artifact.body);
  const file = await pj.join(artifact.bundleDir, "SKILL.md");
  await atomicWrite(fs, file, next);
  const stat = await fs.stat(file);
  return {
    ...artifact,
    raw: next,
    path: file,
    mtimeMs: stat.mtimeMs,
    computedHash: await sha256Hex(next),
  };
}

export async function deleteSkillBundle(fs: FsAdapter, artifact: MarkdownArtifact): Promise<void> {
  if (!artifact.bundleDir) throw new Error("deleteSkillBundle requires bundleDir");
  await fs.remove(artifact.bundleDir, { recursive: true });
}

export async function createSkillBundle(
  fs: FsAdapter,
  pj: PathJoiner,
  parentDir: string,
  name: string,
  description: string,
  tool: Tool,
  scope: Scope,
): Promise<MarkdownArtifact> {
  const bundleDir = await pj.join(parentDir, name);
  await ensureDir(fs, bundleDir);
  const fm = { name, description };
  const body = `# ${name}\n\nDescribe how to use this skill.\n`;
  const raw = stringifyFrontmatter(fm, body);
  const file = await pj.join(bundleDir, "SKILL.md");
  await atomicWrite(fs, file, raw);
  return loadSkillBundle(fs, pj, bundleDir, tool, scope);
}

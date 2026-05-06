import type { FsAdapter } from "../fs";
import { atomicWrite, ensureDir, safeExists, safeReadDir, sha256Hex } from "../fs";
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
    try {
      if (!(await safeExists(fs, skillFile))) continue;
      const artifact = await loadSkillBundle(fs, pj, bundleDir, tool, scope);
      out.push(artifact);
    } catch (err) {
      // One bad bundle (frontmatter parse error, scope-blocked read,
      // unreadable attachment) must not drop every later bundle in the same
      // directory. Log so regressions are visible in DevTools.
      console.warn(`[skill] skipped ${bundleDir}:`, err);
    }
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
  // Guard against recursive-rm through a symlink. If bundleDir is itself a
  // symlink (e.g. listing duplication put a .claude/skills/<n> bridge link
  // in front of the user), unlink the link only — never `rm -r` through it,
  // which would silently wipe the real bundle in .agents/skills/<n>.
  if (fs.removeIfSymlink && (await fs.removeIfSymlink(artifact.bundleDir))) {
    return;
  }
  await fs.remove(artifact.bundleDir, { recursive: true });
  // If the canonical bundle lived under .agents/skills/, install.ts may have
  // dropped a bridge symlink at .claude/skills/<n>. Remove it too — but
  // only if it's actually a symlink, never a real user-populated dir.
  if (fs.removeIfSymlink) {
    const m = artifact.bundleDir.match(/^(.*)[/\\]\.agents[/\\]skills[/\\]([^/\\]+)[/\\]?$/);
    if (m) {
      const projectRoot = m[1];
      const name = m[2];
      const sep = artifact.bundleDir.includes("\\") ? "\\" : "/";
      const linkPath = [projectRoot, ".claude", "skills", name].join(sep);
      try {
        await fs.removeIfSymlink(linkPath);
      } catch {
        // Best-effort cleanup; don't fail the delete if the bridge can't be
        // removed (e.g. permission issue). The orphaned link is broken but
        // harmless — Claude Code just silently skips broken symlinks.
      }
    }
  }
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

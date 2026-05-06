import type { FsAdapter } from "../fs";
import { ensureDir } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { PathResolverDeps } from "../paths";
import { resolveArtifactDir } from "../paths";
import type { Scope, Tool } from "../artifacts/types";
import {
  downloadBlob,
  downloadShareManifest,
  downloadSkillManifest,
} from "./client";
import type { DownloadManifest } from "./types";

/**
 * The live API splits download into two steps:
 *   1. GET /v1/skills/.../download/{version} → JSON manifest of files (path,
 *      hash, size).
 *   2. GET /v1/blobs/{hash} for each file → raw bytes.
 *
 * Share-link downloads use /v1/share/{shareId}/download for step 1 (no auth
 * required) and the same blob endpoint for step 2.
 */

/**
 * Decide where a skill should land on disk for a given (tool, scope,
 * projectRoot). skillsafe.ai distributes tool-agnostic SKILL.md bundles, so
 * we route through the agent registry: every supported tool lands at its
 * own canonical location (e.g. ~/.cursor/skills, ~/.codex/skills, …) per
 * vercel-labs/skills' rules.
 *
 * Claude project installs have two modes:
 *   useSymlink=true  (default) → write bundle to `.agents/skills/<name>`
 *                                and let the caller add a symlink at
 *                                `.claude/skills/<name>`. Saves disk when
 *                                the same bundle is used by other tools.
 *   useSymlink=false           → write bundle directly to `.claude/skills/<name>`
 *                                (a real folder, no `.agents/` involvement).
 */
export async function resolveInstallDir(
  deps: PathResolverDeps,
  pj: PathJoiner,
  tool: Tool,
  scope: Scope,
  projectRoot: string | undefined,
  skillName: string,
  useSymlink: boolean = true,
): Promise<string> {
  const targetScope: Scope = scope === "project" && projectRoot ? "project" : "global";
  let baseDir: string;
  if (tool === "claude" && targetScope === "project" && projectRoot && useSymlink) {
    baseDir = await pj.join(projectRoot, ".agents", "skills");
  } else {
    baseDir = await resolveArtifactDir(deps, tool, targetScope, "skill", projectRoot);
  }
  if (!baseDir) {
    throw new Error(`No install location for ${tool} (${targetScope}). Is the tool registered?`);
  }
  return pj.join(baseDir, skillName);
}

export interface InstallOpts {
  shareId?: string;
  apiKey?: string | null;
  ns?: string;
  name: string;
  version?: string;
  tool: Tool;
  scope: Scope;
  projectRoot?: string;
  // Claude project installs only. Default true — bundle is written to
  // `<project>/.agents/skills/<name>` and a symlink at
  // `<project>/.claude/skills/<name>` makes Claude Code discover it. Lets a
  // single bundle be shared across tools, saving disk. Set false to install
  // the bundle directly into `<project>/.claude/skills/<name>` as a real
  // directory (no `.agents/` involvement, no symlink).
  useSymlink?: boolean;
}

export async function installSkill(
  fs: FsAdapter,
  deps: PathResolverDeps,
  pj: PathJoiner,
  opts: InstallOpts,
): Promise<{ targetDir: string; entries: string[] }> {
  let manifest: DownloadManifest;
  if (opts.shareId) {
    manifest = (await downloadShareManifest(opts.shareId)).data;
  } else if (opts.ns && opts.version) {
    // Public skills don't strictly require a key, but pass it through if we
    // have one so install_count is attributed correctly.
    manifest = (await downloadSkillManifest(opts.ns, opts.name, opts.version, opts.apiKey ?? null)).data;
  } else {
    throw new Error("installSkill: either shareId or (ns + version) required");
  }

  const useSymlink = opts.useSymlink !== false;
  console.info(
    `[install] tool=${opts.tool} scope=${opts.scope} useSymlink=${useSymlink} ` +
      `name=${opts.name} projectRoot=${opts.projectRoot ?? "-"}`,
  );
  const targetDir = await resolveInstallDir(
    deps,
    pj,
    opts.tool,
    opts.scope,
    opts.projectRoot,
    opts.name,
    useSymlink,
  );
  await ensureDir(fs, targetDir);
  const entries: string[] = [];

  for (const f of manifest.files) {
    if (f.path.startsWith("/") || f.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Refusing unsafe file path: ${f.path}`);
    }
    const bytes = await downloadBlob(f.hash, opts.apiKey ?? null);
    const segments = f.path.split("/");
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
    entries.push(f.path);
  }

  // Claude Code only auto-discovers skills under <project>/.claude/skills/.
  // We install to .agents/skills/ to share the bundle across tools, so bridge
  // it with a relative symlink (../../.agents/skills/<name>) — relative so
  // the link survives moving the project root. Skip if anything already
  // exists at the link path so we never clobber user content.
  if (
    opts.tool === "claude" &&
    opts.scope === "project" &&
    opts.projectRoot &&
    useSymlink
  ) {
    await createClaudeSkillsBridge(fs, pj, opts.projectRoot, opts.name);
  }

  return { targetDir, entries };
}

export async function createClaudeSkillsBridge(
  fs: FsAdapter,
  pj: PathJoiner,
  projectRoot: string,
  skillName: string,
): Promise<void> {
  if (!fs.symlink) {
    // Adapter was loaded without symlink support — typically means the
    // Tauri bundle hasn't been rebuilt to include the create_symlink
    // command, or a test fs adapter is in use. Surface it so the install
    // doesn't appear to silently succeed.
    console.warn("[install] fs.symlink unavailable — skipping .claude/skills bridge");
    return;
  }
  const claudeSkillsDir = await pj.join(projectRoot, ".claude", "skills");
  const linkPath = await pj.join(claudeSkillsDir, skillName);
  if (await fs.exists(linkPath)) {
    console.info(`[install] ${linkPath} already exists — leaving it alone`);
    return;
  }
  await ensureDir(fs, claudeSkillsDir);
  // Build the relative target by string concat — `pj.join` (Tauri's path
  // API) normalizes leading `..` segments away, which would produce a
  // broken link like `.agents/skills/<n>` resolved from `.claude/skills/`.
  // We need a literal `../../.agents/skills/<n>` so symlinking from inside
  // `.claude/skills/` resolves up to projectRoot before descending again.
  const sep = linkPath.includes("\\") ? "\\" : "/";
  const relTarget = ["..", "..", ".agents", "skills", skillName].join(sep);
  try {
    await fs.symlink(relTarget, linkPath);
  } catch (err) {
    // Windows without Developer Mode/admin rejects symlink_dir; we don't
    // want to fail the whole install in that case (the bundle is still
    // under .agents/skills/). But we do want the failure visible — silent
    // catches were turning a missing `.claude/skills/` into a mystery.
    console.error(`[install] failed to create bridge symlink ${linkPath} → ${relTarget}:`, err);
  }
}

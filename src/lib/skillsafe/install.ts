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
 * Claude project installs use the universal `<projectRoot>/.agents/skills`
 * location (matching App.tsx::targetDir) so skills installed here line up
 * with what `npx skills add claude-code` would write.
 */
export async function resolveInstallDir(
  deps: PathResolverDeps,
  pj: PathJoiner,
  tool: Tool,
  scope: Scope,
  projectRoot: string | undefined,
  skillName: string,
): Promise<string> {
  const targetScope: Scope = scope === "project" && projectRoot ? "project" : "global";
  let baseDir: string;
  if (tool === "claude" && targetScope === "project" && projectRoot) {
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

  const targetDir = await resolveInstallDir(
    deps,
    pj,
    opts.tool,
    opts.scope,
    opts.projectRoot,
    opts.name,
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

  return { targetDir, entries };
}

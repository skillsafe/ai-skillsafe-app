import type { FsAdapter } from "../fs";
import { ensureDir } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { PathResolverDeps } from "../paths";
import { resolveArtifactDir } from "../paths";
import type { Scope } from "../artifacts/types";
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
 * Decide where a skill should land on disk for a given (scope, projectRoot).
 *
 * Skillsafe.ai distributes Claude-format skills, so we always install under
 * the Claude skills tree — users can convert to other tools afterwards via
 * the existing Convert dialog.
 */
export async function resolveInstallDir(
  deps: PathResolverDeps,
  pj: PathJoiner,
  scope: Scope,
  projectRoot: string | undefined,
  skillName: string,
): Promise<string> {
  const targetScope: Scope = scope === "project" && projectRoot ? "project" : "global";
  const baseDir = await resolveArtifactDir(deps, "claude", targetScope, "skill", projectRoot);
  return pj.join(baseDir, skillName);
}

export interface InstallOpts {
  shareId?: string;
  apiKey?: string | null;
  ns?: string;
  name: string;
  version?: string;
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

  const targetDir = await resolveInstallDir(deps, pj, opts.scope, opts.projectRoot, opts.name);
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

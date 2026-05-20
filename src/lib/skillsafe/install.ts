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
import { runShield, type ShieldDeps, type ShieldVerdict } from "./shield";

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
 * own canonical location (e.g. ~/.cursor/skills, ~/.codex/skills,
 * <project>/.claude/skills, …) per vercel-labs/skills' rules. Bundles are
 * always written as real folders — the historical `.agents/skills/` +
 * symlink-bridge mode was removed because cloud-synced backup destinations
 * (OneDrive/Dropbox/iCloud) don't preserve symlinks, so the bridge broke on
 * the first restore cycle.
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
  const baseDir = await resolveArtifactDir(deps, tool, targetScope, "skill", projectRoot);
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
  /** When set, run the ToxicSkills shield over the freshly written files.
   * Block verdicts throw InstallBlockedError + clean up the partial install;
   * quarantine verdicts write the frontmatter sentinel into SKILL.md. Omit
   * for callers that don't need gating (git install, master restore, tests). */
  shield?: ShieldDeps;
}

export interface InstallResult {
  targetDir: string;
  entries: string[];
  shieldVerdict?: ShieldVerdict;
}

export async function installSkill(
  fs: FsAdapter,
  deps: PathResolverDeps,
  pj: PathJoiner,
  opts: InstallOpts,
): Promise<InstallResult> {
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

  console.info(
    `[install] tool=${opts.tool} scope=${opts.scope} ` +
      `name=${opts.name} projectRoot=${opts.projectRoot ?? "-"}`,
  );
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
  // Track decoded text for the shield's scanner. Binary files (images etc.)
  // have no useful text representation for regex passes, so we keep them out
  // of the scan input; the scanner already skips non-text content anyway.
  const scanInput: Array<{ path: string; content: string; size: number }> = [];

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
    const decoded = new TextDecoder().decode(bytes);
    if (fs.writeFile) {
      await fs.writeFile(fullPath, bytes);
    } else {
      await fs.writeTextFile(fullPath, decoded);
    }
    entries.push(f.path);
    scanInput.push({ path: f.path, content: decoded, size: bytes.length });
  }

  if (opts.shield) {
    const { verdict } = await runShield(opts.shield, {
      files: scanInput,
      targetDir,
    });
    return { targetDir, entries, shieldVerdict: verdict };
  }

  return { targetDir, entries };
}

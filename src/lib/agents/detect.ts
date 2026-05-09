// Tool-installed detection for the Workbench inventory.
//
// Detection here is intentionally cheap: we look for the parent of the
// agent's globalSkillsDir (e.g. ~/.claude/, ~/.codex/) rather than running
// any actual tool binary. False positives are fine — the Workbench surfaces
// the inventory regardless and just won't find anything for an agent the
// user has never run. False negatives would be worse, since they'd hide
// real items the user has on disk.

import type { FsAdapter } from "../fs";
import { safeExists } from "../fs";
import type { PathResolverDeps } from "../paths";
import { getAgentConfig } from "./registry";

function parentOf(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

export async function isInstalled(
  fs: FsAdapter,
  paths: PathResolverDeps,
  tool: string,
): Promise<boolean> {
  const cfg = getAgentConfig(tool);
  if (!cfg) return false;
  // Walk up from globalSkillsDir to its containing app-config dir
  // (~/.claude, ~/.codex, ~/.cursor, …) and check that exists. The skills
  // subdirectory itself rarely exists on a fresh install, so we'd miss
  // most users if we required it.
  const skills = await cfg.globalSkillsDir(paths);
  const parent = parentOf(skills);
  if (parent && (await safeExists(fs, parent))) return true;
  // Some agents share `.agents/skills` (project-only convention) — no
  // discoverable global root. Fall back to the skills dir itself.
  return safeExists(fs, skills);
}

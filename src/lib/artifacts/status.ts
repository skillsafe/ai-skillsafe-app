import type { MarkdownArtifact } from "./types";

// SkillSafe-managed status sentinel, stored under a namespaced object in
// SKILL.md frontmatter so it survives reloads, git, backup/restore, OneDrive
// sync. Agents that ignore the key are unaffected; SkillSafe consumers read
// through the helpers below.
//
// Shape:
//   ---
//   skillsafe:
//     status: quarantined   # | "rewritten" | "clean"
//     reason: "matched rule tx_inducement_setup"
//     set_at: "2026-05-20T10:00:00.000Z"
//   ---

export type SkillSafeStatus = "quarantined" | "rewritten" | "clean";

export interface SkillSafeStatusBlock {
  status: SkillSafeStatus;
  reason?: string;
  set_at?: string;
}

export function getStatusBlock(artifact: Pick<MarkdownArtifact, "frontmatter">): SkillSafeStatusBlock | null {
  const ns = artifact.frontmatter?.skillsafe;
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) return null;
  const block = ns as Record<string, unknown>;
  const status = block.status;
  if (status !== "quarantined" && status !== "rewritten" && status !== "clean") return null;
  return {
    status,
    reason: typeof block.reason === "string" ? block.reason : undefined,
    set_at: typeof block.set_at === "string" ? block.set_at : undefined,
  };
}

export function isQuarantined(artifact: Pick<MarkdownArtifact, "frontmatter">): boolean {
  return getStatusBlock(artifact)?.status === "quarantined";
}

export function isRewritten(artifact: Pick<MarkdownArtifact, "frontmatter">): boolean {
  return getStatusBlock(artifact)?.status === "rewritten";
}

/**
 * Returns a copy of the artifact with the status block updated. Pure — the
 * caller is responsible for persisting (e.g. via saveSkillBundle).
 *
 * Passing `status: "clean"` removes the block entirely instead of writing
 * `status: clean`, keeping benign SKILL.md files free of SkillSafe metadata.
 */
export function setStatus<T extends Pick<MarkdownArtifact, "frontmatter">>(
  artifact: T,
  status: SkillSafeStatus,
  reason?: string,
  now: () => Date = () => new Date(),
): T {
  const fm = { ...(artifact.frontmatter ?? {}) };
  if (status === "clean") {
    const next = { ...fm };
    delete next.skillsafe;
    return { ...artifact, frontmatter: next };
  }
  const block: SkillSafeStatusBlock = {
    status,
    ...(reason ? { reason } : {}),
    set_at: now().toISOString(),
  };
  // Preserve any other keys the user might have added under `skillsafe`
  // (forward-compat with future SkillSafe-namespaced metadata).
  const existing = fm.skillsafe && typeof fm.skillsafe === "object" && !Array.isArray(fm.skillsafe)
    ? (fm.skillsafe as Record<string, unknown>)
    : {};
  fm.skillsafe = { ...existing, ...block };
  return { ...artifact, frontmatter: fm };
}

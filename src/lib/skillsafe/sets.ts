// Skill Sets — a manifest naming N skills at pinned versions, installed as one
// unit. Server-side `/v1/sets/*` endpoints don't ship yet; this module exposes
// the manifest type, a JSON validator, and stub fetchers gated on a feature
// flag so a CI build can still compile and the UI can be smoke-tested against
// a local fixture.

import { z } from "zod";

const setSkillRefSchema = z.object({
  ns: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  optional: z.boolean().optional(),
});

export const skillSetManifestSchema = z.object({
  ns: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  skills: z.array(setSkillRefSchema).min(1),
});

export type SkillSetManifest = z.infer<typeof skillSetManifestSchema>;
export type SkillSetSkillRef = z.infer<typeof setSkillRefSchema>;

export function parseSkillSetManifest(raw: string | unknown): SkillSetManifest {
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  return skillSetManifestSchema.parse(obj);
}

// Feature flag — flip to true once api.skillsafe.ai exposes /v1/sets/*.
export const SKILL_SETS_REMOTE_ENABLED = false;

export interface SearchSetsResult {
  data: SkillSetManifest[];
  meta: { pagination?: { has_more?: boolean; next_cursor?: string | null } };
}

export async function searchSets(_params: { q?: string; limit?: number }): Promise<SearchSetsResult> {
  if (!SKILL_SETS_REMOTE_ENABLED) {
    return { data: [], meta: {} };
  }
  // Real client: add `request<SkillSetManifest[]>("GET", "/v1/sets/search", …)`
  // once the API ships. Kept stubbed so the import graph stays stable for
  // unit tests that exercise the install path.
  return { data: [], meta: {} };
}

export async function getSet(_ns: string, _name: string): Promise<SkillSetManifest | null> {
  if (!SKILL_SETS_REMOTE_ENABLED) return null;
  return null;
}

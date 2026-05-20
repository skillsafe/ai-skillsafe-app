import type { LockfileAdapter, ForeignLockfile } from "./types";

// Canonical SkillSafe v1 format — round-trips through the foreign
// representation without information loss.

export const skillsafeAdapter: LockfileAdapter = {
  format: "skillsafe-v1",

  detect: (_raw, parsed) => {
    if (!parsed || typeof parsed !== "object") return false;
    const obj = parsed as Record<string, unknown>;
    return obj.version === 1 && obj.skills !== undefined && typeof obj.skills === "object" && !Array.isArray(obj.skills);
  },

  parse: (_raw, parsed) => {
    const obj = parsed as Record<string, unknown>;
    const skillsObj = obj.skills as Record<string, Record<string, unknown>>;
    const skills = Object.entries(skillsObj).map(([name, entry]) => {
      const { source, sourceType, computedHash, ...extras } = entry;
      return {
        name,
        source: String(source ?? ""),
        sourceType: typeof sourceType === "string" ? sourceType : undefined,
        hash: typeof computedHash === "string" ? computedHash : undefined,
        extras: Object.keys(extras).length ? extras : undefined,
      };
    });
    const { version, skills: _omit, ...topLevelExtras } = obj;
    void version;
    return {
      format: "skillsafe-v1",
      skills,
      topLevelExtras: Object.keys(topLevelExtras).length ? topLevelExtras : undefined,
    };
  },

  serialize: (foreign: ForeignLockfile) => {
    const skills: Record<string, Record<string, unknown>> = {};
    for (const entry of foreign.skills) {
      skills[entry.name] = {
        source: entry.source,
        sourceType: entry.sourceType ?? "unknown",
        computedHash: entry.hash ?? "",
        ...(entry.extras ?? {}),
      };
    }
    const out = {
      version: 1,
      ...(foreign.topLevelExtras ?? {}),
      skills,
    };
    return JSON.stringify(out, null, 2) + "\n";
  },
};

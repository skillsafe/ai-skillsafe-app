import type { LockfileAdapter, ForeignLockfile } from "./types";

// vercel-labs/skills lockfile (skills-lock.json). Spec inferred from the
// vercel-labs/skills public layout — npm-style: `lockfileVersion` plus a
// keyed `skills` object whose entries carry `resolved` (URL) + `integrity`
// (SRI hash) + `version`. Unknown fields are preserved for round-trip so
// the adapter survives upstream spec drift.

interface VercelEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  [key: string]: unknown;
}

interface VercelFile {
  lockfileVersion?: number;
  skills?: Record<string, VercelEntry>;
  [key: string]: unknown;
}

export const vercelAdapter: LockfileAdapter = {
  format: "vercel",

  detect: (_raw, parsed) => {
    if (!parsed || typeof parsed !== "object") return false;
    const obj = parsed as Record<string, unknown>;
    // The distinctive signature is `lockfileVersion` (npm-style) alongside a
    // `skills` object. SkillSafe v1 uses `version: 1` (literal), not
    // `lockfileVersion`, so the keys don't overlap.
    return (
      "lockfileVersion" in obj &&
      "skills" in obj &&
      obj.skills !== null &&
      typeof obj.skills === "object" &&
      !Array.isArray(obj.skills)
    );
  },

  parse: (_raw, parsed) => {
    const file = parsed as VercelFile;
    const skillsIn = file.skills ?? {};
    const skills: ForeignLockfile["skills"] = Object.entries(skillsIn).map(([name, entry]) => {
      const { version, resolved, integrity, ...extras } = entry;
      return {
        name,
        source: String(resolved ?? ""),
        sourceType: deriveSourceType(resolved),
        hash: typeof integrity === "string" ? integrity : undefined,
        version: typeof version === "string" ? version : undefined,
        extras: Object.keys(extras).length ? extras : undefined,
      };
    });
    const { skills: _omit, ...topLevelExtras } = file;
    return {
      format: "vercel",
      skills,
      topLevelExtras: Object.keys(topLevelExtras).length ? topLevelExtras : undefined,
    };
  },

  serialize: (foreign: ForeignLockfile) => {
    const skills: Record<string, VercelEntry> = {};
    for (const entry of foreign.skills) {
      skills[entry.name] = {
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.source ? { resolved: entry.source } : {}),
        ...(entry.hash ? { integrity: entry.hash } : {}),
        ...(entry.extras ?? {}),
      };
    }
    const out: VercelFile = {
      lockfileVersion: 1,
      ...(foreign.topLevelExtras ?? {}),
      skills,
    };
    return JSON.stringify(out, null, 2) + "\n";
  },
};

function deriveSourceType(resolved: unknown): string | undefined {
  if (typeof resolved !== "string") return undefined;
  if (resolved.startsWith("git+") || resolved.endsWith(".git")) return "git";
  if (resolved.startsWith("https://") || resolved.startsWith("http://")) return "https";
  if (resolved.startsWith("npm:")) return "npm";
  return undefined;
}

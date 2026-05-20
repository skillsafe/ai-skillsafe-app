import type { LockfileAdapter, ForeignLockfile } from "./types";

// pcomans/skills-lock format. Spec inferred from the project's public design
// discussion: array-of-skills with explicit source object and a single hash
// field. Unknown fields are preserved for round-trip in case the project's
// final spec adds metadata we haven't seen yet.
//
//   {
//     "schemaVersion": 1,
//     "skills": [
//       { "name": "...", "source": { "type": "git", "url": "..." }, "ref": "<sha>", "hash": "sha256:..." }
//     ]
//   }

interface PcSource {
  type?: string;
  url?: string;
  [key: string]: unknown;
}

interface PcEntry {
  name?: string;
  source?: PcSource | string;
  ref?: string;
  hash?: string;
  version?: string;
  [key: string]: unknown;
}

interface PcFile {
  schemaVersion?: number;
  skills?: PcEntry[];
  [key: string]: unknown;
}

export const pcomansAdapter: LockfileAdapter = {
  format: "pcomans",

  detect: (_raw, parsed) => {
    if (!parsed || typeof parsed !== "object") return false;
    const obj = parsed as Record<string, unknown>;
    // Distinctive: `schemaVersion` field + `skills` array (not object).
    return "schemaVersion" in obj && Array.isArray(obj.skills);
  },

  parse: (_raw, parsed) => {
    const file = parsed as PcFile;
    const skills: ForeignLockfile["skills"] = (file.skills ?? []).map((entry) => {
      const { name, source, ref, hash, version, ...extras } = entry;
      const src = typeof source === "string" ? source : source?.url ?? "";
      const sourceType = typeof source === "object" && source ? source.type : undefined;
      return {
        name: String(name ?? ""),
        source: String(src),
        sourceType: typeof sourceType === "string" ? sourceType : undefined,
        hash: typeof hash === "string" ? hash : undefined,
        version: typeof version === "string" ? version : typeof ref === "string" ? ref : undefined,
        extras: Object.keys(extras).length ? extras : undefined,
      };
    });
    const { skills: _omit, ...topLevelExtras } = file;
    return {
      format: "pcomans",
      skills,
      topLevelExtras: Object.keys(topLevelExtras).length ? topLevelExtras : undefined,
    };
  },

  serialize: (foreign: ForeignLockfile) => {
    const skills: PcEntry[] = foreign.skills.map((entry) => ({
      name: entry.name,
      source: entry.sourceType
        ? { type: entry.sourceType, url: entry.source }
        : { url: entry.source },
      ...(entry.version ? { ref: entry.version } : {}),
      ...(entry.hash ? { hash: entry.hash } : {}),
      ...(entry.extras ?? {}),
    }));
    const out: PcFile = {
      schemaVersion: 1,
      ...(foreign.topLevelExtras ?? {}),
      skills,
    };
    return JSON.stringify(out, null, 2) + "\n";
  },
};

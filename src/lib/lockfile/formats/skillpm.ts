import type { LockfileAdapter, ForeignLockfile } from "./types";

// skillpm lockfile. Spec inferred — skillpm presents itself as a package
// manager for skills, so the lockfile mimics PEP 665 / Cargo.lock style:
// a top-level `skillpm` namespace + a keyed `packages` object with
// `version`, `source`, `checksum` per entry. Pass-through preserves any
// fields the real spec ends up adding.

interface SpmEntry {
  version?: string;
  source?: string;
  checksum?: string;
  [key: string]: unknown;
}

interface SpmFile {
  skillpm?: {
    version?: number;
    packages?: Record<string, SpmEntry>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const skillpmAdapter: LockfileAdapter = {
  format: "skillpm",

  detect: (_raw, parsed) => {
    if (!parsed || typeof parsed !== "object") return false;
    const obj = parsed as Record<string, unknown>;
    if (!("skillpm" in obj)) return false;
    const ns = obj.skillpm;
    return !!ns && typeof ns === "object" && !Array.isArray(ns);
  },

  parse: (_raw, parsed) => {
    const file = parsed as SpmFile;
    const ns = file.skillpm ?? {};
    const packagesIn = ns.packages ?? {};
    const skills: ForeignLockfile["skills"] = Object.entries(packagesIn).map(([name, entry]) => {
      const { version, source, checksum, ...extras } = entry;
      return {
        name,
        source: String(source ?? ""),
        sourceType: deriveSourceType(source),
        hash: typeof checksum === "string" ? checksum : undefined,
        version: typeof version === "string" ? version : undefined,
        extras: Object.keys(extras).length ? extras : undefined,
      };
    });
    // Preserve the entire skillpm namespace except `packages`, plus any
    // sibling top-level keys.
    const { packages: _omit, ...nsExtras } = ns;
    const { skillpm: _ns, ...rest } = file;
    return {
      format: "skillpm",
      skills,
      topLevelExtras: {
        ...rest,
        skillpmExtras: Object.keys(nsExtras).length ? nsExtras : undefined,
      },
    };
  },

  serialize: (foreign: ForeignLockfile) => {
    const packages: Record<string, SpmEntry> = {};
    for (const entry of foreign.skills) {
      packages[entry.name] = {
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.source ? { source: entry.source } : {}),
        ...(entry.hash ? { checksum: entry.hash } : {}),
        ...(entry.extras ?? {}),
      };
    }
    const { skillpmExtras, ...topRest } = (foreign.topLevelExtras ?? {}) as Record<string, unknown>;
    const nsExtras = (skillpmExtras as Record<string, unknown> | undefined) ?? {};
    const out: SpmFile = {
      ...topRest,
      skillpm: {
        version: 1,
        ...nsExtras,
        packages,
      },
    };
    return JSON.stringify(out, null, 2) + "\n";
  },
};

function deriveSourceType(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  if (source.startsWith("git+") || source.endsWith(".git")) return "git";
  if (source.startsWith("https://") || source.startsWith("http://")) return "https";
  if (source.startsWith("registry:")) return "registry";
  return undefined;
}

import type { Lockfile } from "../../lockfile";

// LockfileAdapter is the plug-in point for foreign lockfile specs. Each
// format-specific module exports a `LockfileAdapter` that can detect, parse,
// and serialize that format. The registry in ./index.ts dispatches.
//
// Adapters are pure: they take strings and return JSON values. fs access,
// path resolution, and UI prompts are the caller's concern.
//
// Pass-through is mandatory. Each adapter must round-trip unknown top-level
// keys + unknown per-skill fields through `extras` so importing → exporting
// the same file produces a byte-for-byte (modulo formatting) match.

export type LockfileFormat =
  | "skillsafe-v1"
  | "vercel"
  | "pcomans"
  | "skillpm"
  | "pixi"
  | "unknown";

export interface ForeignLockfileEntry {
  /** Skill identifier (key in the source format). */
  name: string;
  /** Resolved source URL, registry coordinate, or "name@version" — whatever
   * the source format uses as the canonical reference. */
  source: string;
  /** Format hint preserved alongside the source (e.g. "git", "https", "npm"). */
  sourceType?: string;
  /** Content hash if the source format carries one. */
  hash?: string;
  /** Pinned version string if present. */
  version?: string;
  /** Unknown per-skill fields, preserved for round-trip. */
  extras?: Record<string, unknown>;
}

export interface ForeignLockfile {
  format: LockfileFormat;
  skills: ForeignLockfileEntry[];
  /** Top-level fields outside `skills` — preserved for round-trip. */
  topLevelExtras?: Record<string, unknown>;
}

export interface LockfileAdapter {
  format: LockfileFormat;
  /** Returns true if the raw text/json looks like this format. Heuristic. */
  detect: (raw: string, parsed: unknown) => boolean;
  /** Parse raw text into the canonical foreign representation. Throws on
   * malformed input. Must preserve unknown fields via `extras`. */
  parse: (raw: string, parsed: unknown) => ForeignLockfile;
  /** Serialize a foreign representation back to the source format. */
  serialize: (foreign: ForeignLockfile) => string;
}

/** Convert a foreign lockfile into the canonical SkillSafe v1 shape. */
export function foreignToSkillsafe(foreign: ForeignLockfile): Lockfile {
  const skills: Lockfile["skills"] = {};
  for (const entry of foreign.skills) {
    skills[entry.name] = {
      source: entry.source,
      sourceType: entry.sourceType ?? foreign.format,
      computedHash: entry.hash ?? "",
    };
  }
  return { version: 1, skills };
}

export class UnsupportedFormatError extends Error {
  constructor(format: LockfileFormat) {
    super(`Lockfile format '${format}' detected but no adapter is registered.`);
    this.name = "UnsupportedFormatError";
  }
}

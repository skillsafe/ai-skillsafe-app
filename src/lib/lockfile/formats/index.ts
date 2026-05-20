import { skillsafeAdapter } from "./skillsafe";
import { vercelAdapter } from "./vercel";
import { pcomansAdapter } from "./pcomans";
import { skillpmAdapter } from "./skillpm";
import { pixiAdapter } from "./pixi";
import type { ForeignLockfile, LockfileAdapter, LockfileFormat } from "./types";

export type { ForeignLockfile, LockfileAdapter, LockfileFormat } from "./types";
export { UnsupportedFormatError, foreignToSkillsafe } from "./types";

// Detection order matters: more specific formats first so a vercel file
// (which has both `lockfileVersion` and `skills`) isn't misclassified as
// skillsafe-v1 (which also has `skills`).
const ADAPTERS: LockfileAdapter[] = [
  vercelAdapter,
  pcomansAdapter,
  skillpmAdapter,
  pixiAdapter,
  skillsafeAdapter, // fallback — broadest signature, runs last
];

export function detectLockfileFormat(raw: string): LockfileFormat {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // YAML / TOML / corrupt — adapters with raw-text heuristics (pixi) can
    // still match. Leave `parsed` null otherwise.
  }
  for (const adapter of ADAPTERS) {
    if (adapter.detect(raw, parsed)) return adapter.format;
  }
  return "unknown";
}

export function getAdapter(format: LockfileFormat): LockfileAdapter | null {
  return ADAPTERS.find((a) => a.format === format) ?? null;
}

export function importLockfile(raw: string): ForeignLockfile {
  const format = detectLockfileFormat(raw);
  if (format === "unknown") {
    throw new Error("Lockfile format not recognized. Supported: skillsafe-v1, vercel, pcomans, skillpm, pixi (detect-only).");
  }
  const adapter = getAdapter(format);
  if (!adapter) {
    throw new Error(`No adapter registered for format '${format}'.`);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // YAML formats — adapter parse() handles raw text itself.
  }
  return adapter.parse(raw, parsed);
}

export function exportLockfile(foreign: ForeignLockfile, targetFormat?: LockfileFormat): string {
  const format = targetFormat ?? foreign.format;
  const adapter = getAdapter(format);
  if (!adapter) {
    throw new Error(`No adapter registered for format '${format}'.`);
  }
  return adapter.serialize({ ...foreign, format });
}

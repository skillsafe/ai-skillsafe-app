import { z } from "zod";
import type { FsAdapter } from "./fs";
import { atomicWrite, ensureDir, sha256Hex } from "./fs";
import type { PathJoiner } from "./artifacts/skill";

export const lockfileSchema = z.object({
  version: z.literal(1),
  skills: z.record(
    z.string(),
    z.object({
      source: z.string(),
      sourceType: z.string(),
      computedHash: z.string(),
    }),
  ),
});

export type Lockfile = z.infer<typeof lockfileSchema>;

export async function readLockfile(fs: FsAdapter, path: string): Promise<Lockfile | null> {
  if (!(await fs.exists(path))) return null;
  const raw = await fs.readTextFile(path);
  const json: unknown = JSON.parse(raw);
  return lockfileSchema.parse(json);
}

export async function writeLockfile(
  fs: FsAdapter,
  pj: PathJoiner,
  path: string,
  lockfile: Lockfile,
): Promise<void> {
  // Validate before write so an invalid in-memory state never lands on disk.
  // Skips the parse on the happy path's hot loop because the caller mutates
  // a known-good shape; the cost is one sort/serialize cycle.
  const parsed = lockfileSchema.parse(lockfile);
  // Canonicalize key order so two clients producing the same skill set
  // produce byte-identical files (git-friendly).
  const skills: Lockfile["skills"] = {};
  for (const name of Object.keys(parsed.skills).sort()) {
    skills[name] = parsed.skills[name];
  }
  const canonical: Lockfile = { version: parsed.version, skills };
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastSep > 0) {
    const dir = path.slice(0, lastSep);
    await ensureDir(fs, dir);
  }
  await atomicWrite(fs, path, JSON.stringify(canonical, null, 2) + "\n");
  // pj is accepted (and not used today) so a future refactor can resolve
  // the lockfile path through the joiner without an API break.
  void pj;
}

export async function computeBundleHash(
  fs: FsAdapter,
  pj: PathJoiner,
  bundleDir: string,
): Promise<string> {
  const skillFile = await pj.join(bundleDir, "SKILL.md");
  if (!(await fs.exists(skillFile))) return "";
  const raw = await fs.readTextFile(skillFile);
  return sha256Hex(raw);
}

export interface DriftReport {
  name: string;
  expected: string;
  actual: string;
  drift: boolean;
}

export async function detectDrift(
  fs: FsAdapter,
  pj: PathJoiner,
  lockfile: Lockfile,
  resolveBundleDir: (name: string) => Promise<string>,
): Promise<DriftReport[]> {
  const reports: DriftReport[] = [];
  for (const [name, entry] of Object.entries(lockfile.skills)) {
    const dir = await resolveBundleDir(name);
    const actual = await computeBundleHash(fs, pj, dir);
    reports.push({
      name,
      expected: entry.computedHash,
      actual,
      drift: actual !== "" && actual !== entry.computedHash,
    });
  }
  return reports;
}

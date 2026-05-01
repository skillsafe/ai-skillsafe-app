import { z } from "zod";
import type { FsAdapter } from "./fs";
import { sha256Hex } from "./fs";
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

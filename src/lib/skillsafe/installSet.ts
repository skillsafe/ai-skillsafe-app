import type { FsAdapter } from "../fs";
import type { PathJoiner } from "../artifacts/skill";
import type { PathResolverDeps } from "../paths";
import type { Scope, Tool } from "../artifacts/types";
import type { SkillSetManifest, SkillSetSkillRef } from "./sets";

export interface InstallSetOptions {
  apiKey: string | null;
  manifest: SkillSetManifest;
  // Restrict the install to a subset by stable ref id (`${ns}/${name}`).
  // When undefined, every skill in the manifest is installed.
  selected?: Set<string>;
  tool: Tool;
  scope: Scope;
  projectRoot?: string;
  // Per-skill installer. Defaults to the production `installSkill`; tests
  // inject a mock to avoid network calls.
  installSkill: (opts: {
    apiKey: string | null;
    ns: string;
    name: string;
    version: string;
    tool: Tool;
    scope: Scope;
    projectRoot?: string;
  }) => Promise<{ targetDir: string; entries: string[] }>;
  fs: FsAdapter;
  paths: PathResolverDeps;
  joiner: PathJoiner;
  onProgress?: (event: SetProgressEvent) => void;
}

export type SetProgressEvent =
  | { kind: "start"; total: number }
  | { kind: "skill-start"; ref: SkillSetSkillRef; index: number; total: number }
  | { kind: "skill-ok"; ref: SkillSetSkillRef; targetDir: string }
  | { kind: "skill-error"; ref: SkillSetSkillRef; error: string }
  | { kind: "done"; installed: number; failed: number; skipped: number };

export interface InstallSetResult {
  installed: SkillSetSkillRef[];
  failed: Array<{ ref: SkillSetSkillRef; error: string }>;
  skipped: SkillSetSkillRef[];
}

// Sequential install. Failures are collected; the caller decides whether to
// abort, skip, or retry — we don't try to be cute about parallel network use
// because the existing per-skill installer already does many blob fetches per
// skill, and parallelism here would risk overwhelming the api rate limit.
export async function installSet(opts: InstallSetOptions): Promise<InstallSetResult> {
  const refs = opts.manifest.skills;
  const targets = opts.selected
    ? refs.filter((r) => opts.selected!.has(refKey(r)))
    : refs;
  const installed: SkillSetSkillRef[] = [];
  const failed: Array<{ ref: SkillSetSkillRef; error: string }> = [];
  const skipped: SkillSetSkillRef[] = refs.filter((r) => !targets.includes(r));

  opts.onProgress?.({ kind: "start", total: targets.length });

  for (let i = 0; i < targets.length; i++) {
    const ref = targets[i];
    opts.onProgress?.({ kind: "skill-start", ref, index: i, total: targets.length });
    try {
      const res = await opts.installSkill({
        apiKey: opts.apiKey,
        ns: ref.ns,
        name: ref.name,
        version: ref.version,
        tool: opts.tool,
        scope: opts.scope,
        projectRoot: opts.projectRoot,
      });
      installed.push(ref);
      opts.onProgress?.({ kind: "skill-ok", ref, targetDir: res.targetDir });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // `optional: true` skills don't move the failed counter — the user
      // explicitly opted in to "best-effort" semantics for those.
      if (ref.optional) {
        skipped.push(ref);
      } else {
        failed.push({ ref, error });
      }
      opts.onProgress?.({ kind: "skill-error", ref, error });
    }
  }

  opts.onProgress?.({
    kind: "done",
    installed: installed.length,
    failed: failed.length,
    skipped: skipped.length,
  });
  return { installed, failed, skipped };
}

export function refKey(r: SkillSetSkillRef): string {
  return `${r.ns}/${r.name}`;
}

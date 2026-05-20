import type { ScanResult } from "../scan/scanner";
import type { ToxicSkillsPayload } from "../feeds/types";

// ToxicSkills Pre-Install Shield: maps scanner findings against the
// rule-feed policy and decides what to do with a downloaded bundle.
//
// Pure function — no fs, no fetch. Caller is responsible for:
//   - running scanFiles() on the downloaded files
//   - loading the feed (cached or fresh)
//   - acting on the verdict (cleanup partial install on "block",
//     write the quarantine sentinel on "quarantine", proceed on "allow")
//
// "block" wins ties: if any rule_id matches both lists, the more cautious
// behavior is selected. Empty feed = fail-open (everything allowed). This is
// intentional — first launch + offline + no signed feed shouldn't brick the
// install path; the feed is harm-reduction, not the only line of defense.

export type ShieldVerdict =
  | { kind: "allow" }
  | { kind: "quarantine"; matchedRules: string[]; reason: string }
  | { kind: "block"; matchedRules: string[]; reason: string };

export interface ShieldInput {
  scan: ScanResult;
  policy: ToxicSkillsPayload;
}

export function evaluateInstall({ scan, policy }: ShieldInput): ShieldVerdict {
  const blocked = matchRules(scan.raw_findings.map((f) => f.rule_id), policy.block_rules);
  if (blocked.length > 0) {
    return {
      kind: "block",
      matchedRules: blocked,
      reason: humanReason(scan, blocked, "block"),
    };
  }
  const quarantined = matchRules(scan.raw_findings.map((f) => f.rule_id), policy.quarantine_rules);
  if (quarantined.length > 0) {
    return {
      kind: "quarantine",
      matchedRules: quarantined,
      reason: humanReason(scan, quarantined, "quarantine"),
    };
  }
  return { kind: "allow" };
}

/** Returns the distinct findings rule_ids that match any pattern in `patterns`.
 * Patterns support a trailing `*` for prefix matching (`reverse_shell_*`). */
function matchRules(ruleIds: readonly string[], patterns: readonly string[]): string[] {
  const matched = new Set<string>();
  for (const id of ruleIds) {
    for (const pattern of patterns) {
      if (matchesPattern(id, pattern)) {
        matched.add(id);
        break;
      }
    }
  }
  return [...matched].sort();
}

function matchesPattern(ruleId: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return ruleId.startsWith(pattern.slice(0, -1));
  }
  return ruleId === pattern;
}

function humanReason(scan: ScanResult, matched: string[], kind: "block" | "quarantine"): string {
  // Pull a representative finding's message for each matched rule so the
  // dialog can show file:line context without re-scanning. One per rule
  // keeps the reason terse even when a rule fires many times.
  const samples: string[] = [];
  for (const rule of matched.slice(0, 3)) {
    const finding = scan.raw_findings.find((f) => f.rule_id === rule);
    if (!finding) continue;
    samples.push(`${rule} (${finding.file}:${finding.line})`);
  }
  const more = matched.length > 3 ? ` and ${matched.length - 3} more` : "";
  const action = kind === "block" ? "blocked" : "quarantined";
  return `${action}: ${samples.join(", ")}${more}`;
}

export class InstallBlockedError extends Error {
  readonly verdict: Extract<ShieldVerdict, { kind: "block" }>;
  constructor(verdict: Extract<ShieldVerdict, { kind: "block" }>) {
    super(verdict.reason);
    this.name = "InstallBlockedError";
    this.verdict = verdict;
  }
}

import type { FsAdapter } from "../fs";
import { atomicWrite } from "../fs";
import { scanFiles, type FileEntry } from "../scan/scanner";
import type { PathJoiner } from "../artifacts/skill";
import { parseFrontmatter, stringifyFrontmatter } from "../frontmatter";
import { setStatus } from "../artifacts/status";
import type { FeedClient } from "../feeds/client";

export interface ShieldDeps {
  fs: FsAdapter;
  pj: PathJoiner;
  feed: FeedClient;
}

export interface ShieldRunInput {
  /** Files that were just written, keyed by their bundle-relative path. */
  files: Array<{ path: string; content: string; size: number }>;
  /** Absolute install dir — used by `block` to clean up partial install. */
  targetDir: string;
}

export interface ShieldRunResult {
  verdict: ShieldVerdict;
  /** The ScanResult so callers can surface findings in toast/dialog. */
  scan: ReturnType<typeof scanFiles>;
}

/**
 * Run the shield over a freshly installed bundle. On `block`, cleans up the
 * partial install + throws InstallBlockedError. On `quarantine`, writes the
 * frontmatter sentinel into SKILL.md. On `allow`, returns the (clean) verdict.
 */
export async function runShield(
  deps: ShieldDeps,
  input: ShieldRunInput,
): Promise<ShieldRunResult> {
  const scan = scanFiles(input.files as FileEntry[]);
  const policy = await deps.feed.load("toxic-skills");
  const verdict = evaluateInstall({ scan, policy });

  if (verdict.kind === "block") {
    // Wipe the partial install before throwing so the user doesn't end up
    // with files on disk for a rejected skill. Recursive remove is safe here
    // because installSkill() created targetDir itself (no symlink-through risk).
    try {
      await deps.fs.remove(input.targetDir, { recursive: true });
    } catch (err) {
      console.warn("[shield] cleanup failed for", input.targetDir, err);
    }
    throw new InstallBlockedError(verdict);
  }

  if (verdict.kind === "quarantine") {
    await writeQuarantineSentinel(deps, input.targetDir, verdict.reason);
  }

  return { verdict, scan };
}

async function writeQuarantineSentinel(
  deps: ShieldDeps,
  targetDir: string,
  reason: string,
): Promise<void> {
  const skillPath = await deps.pj.join(targetDir, "SKILL.md");
  try {
    const raw = await deps.fs.readTextFile(skillPath);
    const { data, body } = parseFrontmatter(raw);
    const next = setStatus({ frontmatter: data }, "quarantined", reason);
    const out = stringifyFrontmatter(next.frontmatter, body);
    await atomicWrite(deps.fs, skillPath, out);
  } catch (err) {
    // Best-effort: a bundle without a SKILL.md (or read-only fs) should not
    // turn a quarantine into a block. The artifact list still shows the
    // findings via the in-memory scan report.
    console.warn("[shield] could not write quarantine sentinel to", skillPath, err);
  }
}

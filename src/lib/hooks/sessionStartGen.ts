// SessionStart-hook generator for Claude Code.
//
// Emits a hook entry suitable for ~/.claude/settings.json that bails out of
// the session if any quarantined SkillSafe artifact is loaded. v1 uses a
// portable shell command (grep + find) instead of shelling out to a CLI we
// don't ship yet — so the protection works on a fresh install without any
// external binary.
//
// The hook is emitted as a JSON-serializable object; the caller is
// responsible for merging it into the user's settings file (or rendering
// it as a copy-paste snippet) — keeping this module side-effect free.
//
// Shape (matches Claude Code's hook config):
//   {
//     "SessionStart": [
//       {
//         "matcher": "*",
//         "hooks": [{ "type": "command", "command": "...", "timeout": 5 }]
//       }
//     ]
//   }
//
// The command grep-checks the project tree's .claude/skills + ~/.claude/skills
// for `skillsafe:` blocks whose status is `quarantined`. Exit status 2 makes
// Claude Code abort the session before any skill is loaded.

export interface SessionStartHookEntry {
  SessionStart: Array<{
    matcher: string;
    hooks: Array<{ type: "command"; command: string; timeout?: number }>;
  }>;
}

export interface HookGenInput {
  /** Absolute path to ~/.claude/skills (or the directory the user's tool
   * stores skill bundles in). Used in the generated grep command. */
  globalSkillsDir: string;
  /** Absolute path to the project root, or null/undefined for a global-only
   * hook. The generated command checks both when set. */
  projectRoot?: string | null;
}

/** Render the hook entry. */
export function generateSessionStartHook(input: HookGenInput): SessionStartHookEntry {
  return {
    SessionStart: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: renderCommand(input),
            timeout: 5,
          },
        ],
      },
    ],
  };
}

/** Renders just the command string — exported for tests + the settings UI's
 * copy-button. */
export function renderCommand(input: HookGenInput): string {
  // Quote each path with single quotes; the embedded paths are user-chosen
  // so we conservatively shell-escape any single quotes within them by
  // ending the single-quoted string, inserting an escaped quote, and
  // re-opening. This is the standard POSIX idiom.
  const targets = [input.globalSkillsDir];
  if (input.projectRoot) {
    // Conventional skill dirs under a project: .claude/skills/ + .agents/skills/.
    targets.push(`${input.projectRoot}/.claude/skills`);
    targets.push(`${input.projectRoot}/.agents/skills`);
  }
  const quotedTargets = targets.map(shellEscape).join(" ");
  // grep -l … prints a filename if it matches; -q would suppress all output,
  // we want the filename for diagnostic context.
  //
  // The regex looks for `status: quarantined` on a line beneath a `skillsafe:`
  // block. We don't try to be YAML-aware — a literal match catches the
  // sentinel SkillSafe writes and is robust to wrapping whitespace.
  const sentinel = "status: quarantined";
  return (
    `if grep -rlE '${sentinel.replace(/'/g, "'\\''")}' ${quotedTargets} 2>/dev/null | grep -q . ; then ` +
    `echo "skillsafe: quarantined skills detected — refusing to start" >&2; exit 2; ` +
    `fi`
  );
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Merges a generated hook entry into an existing Claude Code settings.json
 * shape. The user may already have unrelated SessionStart hooks — those are
 * preserved. A previously generated SkillSafe hook (recognized by a sentinel
 * comment in the command) is replaced rather than duplicated, so calling
 * this twice is idempotent.
 */
export function mergeHookIntoSettings(
  settings: Record<string, unknown>,
  entry: SessionStartHookEntry,
): Record<string, unknown> {
  const next = { ...settings };
  const existing = Array.isArray(next.SessionStart) ? [...(next.SessionStart as unknown[])] : [];
  // Drop prior SkillSafe-generated SessionStart blocks. We tag generated
  // blocks via the `skillsafe-quarantine-gate` marker stored on the matcher
  // — invisible to Claude Code, but distinctive enough to find again.
  const filtered = existing.filter((block) => {
    if (!block || typeof block !== "object") return true;
    const b = block as Record<string, unknown>;
    return b.skillsafe_id !== "quarantine-gate";
  });
  for (const block of entry.SessionStart) {
    filtered.push({ ...block, skillsafe_id: "quarantine-gate" });
  }
  next.SessionStart = filtered;
  return next;
}

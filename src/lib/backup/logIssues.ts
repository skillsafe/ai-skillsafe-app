// Post-mortem log scanner. Parses the backup log tail and flags known
// failure patterns the user can act on directly, so the BackupPanel can
// surface a guided fix instead of leaving them to read raw rsync errors.

export type IssueKind = "tcc-cloudstorage-eperm";

export interface BackupLogIssue {
  kind: IssueKind;
  /** Distinct destination directories that hit the failure. */
  paths: string[];
  /** Highest-precision timestamp seen on any matched line, if parseable. */
  occurredAt: number | null;
}

// Matches rsync's "open: Operation not permitted" failure on a destination
// directory under macOS's protected CloudStorage tree. Example line:
//
//   rsync(34020): error: /Users/.../Library/CloudStorage/OneDrive-.../foo/: open: Operation not permitted
//
// The destination path is the load-bearing detail — that's what the user
// needs to act on (delete it so rsync recreates it, or grant TCC). We
// don't require the rsync prefix because in some terminals the error is
// re-emitted without it.
const TCC_EPERM_RE =
  /(\/Users\/[^/]+\/Library\/CloudStorage\/[^:]+?\/):\s*open:\s*Operation not permitted/g;

const TIMESTAMP_RE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;

export function detectLogIssues(text: string): BackupLogIssue[] {
  const paths = new Set<string>();
  let occurredAt: number | null = null;

  for (const line of text.split(/\r?\n/)) {
    const stamp = line.match(TIMESTAMP_RE);
    if (stamp) {
      const ms = Date.parse(stamp[1].replace(" ", "T"));
      if (!Number.isNaN(ms)) occurredAt = ms;
    }
    for (const m of line.matchAll(TCC_EPERM_RE)) {
      paths.add(m[1]);
    }
  }

  if (paths.size === 0) return [];
  return [
    {
      kind: "tcc-cloudstorage-eperm",
      paths: [...paths].sort(),
      occurredAt,
    },
  ];
}

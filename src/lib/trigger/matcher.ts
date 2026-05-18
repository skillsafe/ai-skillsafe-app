// Trigger / conflict matcher.
//
// Claude Code (and every "skills" implementation that's followed since)
// selects skills by comparing the user's message against each skill's
// description, then loading the body of any skill it considers a match.
// Users routinely ask "why didn't my skill fire?" — the answer is hidden
// inside that opaque match step.
//
// This module is a tractable local approximation: tokenize on the same
// lowercased word boundaries the IDE uses for shallow text matching, score
// candidates by token overlap against (name + description), and also
// surface conflicts (two skills with descriptions similar enough that the
// model would likely pick the wrong one). Precedence is reported but
// never used to drop losers from the result — the whole point is to make
// shadowing visible.

export type Source = "project" | "global" | "plugin" | "remote" | "master" | "unknown";

export interface Candidate {
  /** Stable identifier (the artifact / inventory id). */
  id: string;
  /** Display name (frontmatter `name`, falling back to file basename). */
  name: string;
  /** Tool key (claude, codex, cursor, …). */
  tool: string;
  /** Source / origin of the candidate. Drives precedence. */
  source: Source;
  /** Project scope's directory, when relevant. */
  projectPath?: string | null;
  /** Free-form description used for matching. */
  description: string;
  /**
   * Absolute on-disk path to the artifact (bundle dir or single file).
   * Surfaced in the UI so a user looking at two same-name candidates can
   * tell them apart and go act on the right one.
   */
  path?: string;
}

export interface Match {
  candidate: Candidate;
  /** 0..1 token-overlap score. */
  score: number;
  /** Query tokens that matched a candidate token. */
  matchedTokens: string[];
  /** Higher = higher precedence. Tied scores break here. */
  precedenceRank: number;
  /**
   * If a higher-precedence candidate has a similar name, this is its id.
   * "Why didn't my global skill fire?" → because the project one shadowed it.
   */
  shadowedBy?: string;
}

export interface ConflictPair {
  a: Candidate;
  b: Candidate;
  /** 0..1 cosine-similarity over (name+description) tokens. */
  similarity: number;
  reason: "name" | "description";
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "these",
  "those", "what", "when", "where", "which", "while", "your", "use",
  "using", "uses", "used", "have", "has", "had", "are", "was", "were",
  "you", "any", "all", "but", "not", "can", "should", "would", "could",
  "may", "might", "must", "just", "very", "also", "than", "then", "now",
  "via", "per", "out", "off", "off", "off",
]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function precedenceRank(source: Source): number {
  // Project beats global beats plugin beats remote/master. Higher = wins.
  switch (source) {
    case "project": return 4;
    case "global": return 3;
    case "plugin": return 2;
    case "remote": return 1;
    case "master": return 1;
    default: return 0;
  }
}

export interface MatchOptions {
  /** Restrict to a single tool. */
  tool?: string;
  /** Minimum score to include in results. Default 0.01. */
  minScore?: number;
}

export function matchCandidates(
  query: string,
  candidates: Candidate[],
  opts: MatchOptions = {},
): Match[] {
  const qTokens = uniq(tokenize(query));
  if (qTokens.length === 0) return [];
  const min = opts.minScore ?? 0.01;
  const matches: Match[] = [];

  for (const c of candidates) {
    if (opts.tool && c.tool !== opts.tool) continue;
    const cTokens = new Set(tokenize(`${c.name} ${c.description}`));
    if (cTokens.size === 0) continue;
    const matched = qTokens.filter((t) => cTokens.has(t));
    if (matched.length === 0) continue;
    // Score = matched / total query tokens, biased toward longer matches.
    let score = matched.length / qTokens.length;
    if (matched.length === qTokens.length) score = Math.min(1, score + 0.15);
    if (score < min) continue;
    matches.push({
      candidate: c,
      score,
      matchedTokens: matched,
      precedenceRank: precedenceRank(c.source),
    });
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.precedenceRank !== a.precedenceRank) return b.precedenceRank - a.precedenceRank;
    return a.candidate.name.localeCompare(b.candidate.name);
  });

  // Annotate shadowing: for each candidate name, if there's a
  // higher-precedence candidate with the same normalized name and same
  // tool, mark the lower as shadowed.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const byKey = new Map<string, Match[]>();
  for (const m of matches) {
    const key = `${m.candidate.tool}|${norm(m.candidate.name)}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(m);
    else byKey.set(key, [m]);
  }
  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => b.precedenceRank - a.precedenceRank);
    const winner = bucket[0];
    for (let i = 1; i < bucket.length; i++) {
      // Same precedence = co-equals, not shadowed (e.g. two skills with the
      // same name in two different projects). Strictly lower = shadowed.
      if (bucket[i].precedenceRank < winner.precedenceRank) {
        bucket[i].shadowedBy = winner.candidate.id;
      }
    }
  }

  return matches;
}

// Cosine similarity over token bags. Cheap and good enough for "these two
// descriptions are basically the same".
export function cosineSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const ca: Record<string, number> = {};
  const cb: Record<string, number> = {};
  for (const t of a) ca[t] = (ca[t] ?? 0) + 1;
  for (const t of b) cb[t] = (cb[t] ?? 0) + 1;
  let dot = 0;
  for (const t of Object.keys(ca)) {
    if (cb[t]) dot += ca[t] * cb[t];
  }
  const norm = (c: Record<string, number>) =>
    Math.sqrt(Object.values(c).reduce((s, v) => s + v * v, 0));
  const denom = norm(ca) * norm(cb);
  return denom === 0 ? 0 : dot / denom;
}

export function findConflicts(
  candidates: Candidate[],
  similarityThreshold = 0.85,
): ConflictPair[] {
  const out: ConflictPair[] = [];
  const tokens = candidates.map((c) => ({
    c,
    desc: tokenize(c.description),
    name: tokenize(c.name),
  }));
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const a = tokens[i];
      const b = tokens[j];
      if (a.c.tool !== b.c.tool) continue;
      // Same exact name within the same tool is always a conflict candidate,
      // even if the descriptions diverge — shadowing semantics rely on names.
      if (a.c.name.toLowerCase() === b.c.name.toLowerCase()) {
        out.push({ a: a.c, b: b.c, similarity: 1, reason: "name" });
        continue;
      }
      const sim = cosineSimilarity(a.desc, b.desc);
      if (sim >= similarityThreshold) {
        out.push({ a: a.c, b: b.c, similarity: sim, reason: "description" });
      }
    }
  }
  out.sort((x, y) => y.similarity - x.similarity);
  return out;
}

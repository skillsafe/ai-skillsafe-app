import type { RawFinding } from "../scan/scanner";
import type { MemorySource } from "./walker";

// Pairwise contradiction detection across memory sources. Heuristic — we
// can't AST-parse English. The bar is: surface obvious "always X / never X"
// pairs and conflicting tool/model directives. False positives are
// acceptable; false negatives are fine too (this is a hint, not a gate).
//
// Each finding's `file` is one of the conflicting source paths, `message`
// names the other source so the user can locate both.

type Imperative = { polarity: "always" | "never"; subject: string };

const IMPERATIVE_RES: RegExp[] = [
  /\b(?:always|must|always)\s+([a-z][\w\s-]{2,40}?)(?:[.!]|\n|$)/gi,
  /\b(?:never|do\s+not|don't)\s+([a-z][\w\s-]{2,40}?)(?:[.!]|\n|$)/gi,
];

const MODEL_OVERRIDE_RE = /\b(?:use|prefer)\s+(?:model\s+)?([a-z]+(?:-[a-z0-9]+){1,5})\b/gi;

export function findContradictions(sources: ReadonlyArray<MemorySource>): RawFinding[] {
  const out: RawFinding[] = [];

  // 1. Imperative contradictions (always/never on similar subjects).
  const imperatives = sources.map((s) => ({ source: s, list: extractImperatives(s.content) }));
  for (let i = 0; i < imperatives.length; i++) {
    for (let j = i + 1; j < imperatives.length; j++) {
      const a = imperatives[i];
      const b = imperatives[j];
      for (const imp1 of a.list) {
        for (const imp2 of b.list) {
          if (imp1.polarity === imp2.polarity) continue;
          if (!similarSubjects(imp1.subject, imp2.subject)) continue;
          out.push({
            rule_id: "mem_imperative_conflict",
            severity: "medium",
            file: a.source.path,
            line: 0,
            message:
              `'${imp1.polarity} ${imp1.subject}' here conflicts with ` +
              `'${imp2.polarity} ${imp2.subject}' in ${b.source.path}`,
          });
        }
      }
    }
  }

  // 2. Conflicting model overrides — "use claude-sonnet-4-6" in one file +
  // "use claude-opus-4-7" in another is almost always a misalignment.
  const models = sources.map((s) => ({ source: s, models: extractModels(s.content) }));
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = models[i];
      const b = models[j];
      for (const m1 of a.models) {
        for (const m2 of b.models) {
          if (m1 === m2) continue;
          // Only flag pairs that look like the same family — claude-X vs claude-Y,
          // not claude-X vs gpt-X (which is intentional cross-tool config).
          if (sameModelFamily(m1, m2)) {
            out.push({
              rule_id: "mem_model_override_conflict",
              severity: "low",
              file: a.source.path,
              line: 0,
              message:
                `Suggests '${m1}' here vs '${m2}' in ${b.source.path}; ` +
                `the lower-precedence file's directive is effectively ignored.`,
            });
          }
        }
      }
    }
  }

  return out;
}

function extractImperatives(text: string): Imperative[] {
  const out: Imperative[] = [];
  // First pass — always/must.
  for (const re of IMPERATIVE_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const subject = normalize(m[1]);
      if (!subject) continue;
      const polarity: Imperative["polarity"] = /\bnever|do\s+not|don't\b/i.test(m[0]) ? "never" : "always";
      out.push({ polarity, subject });
    }
  }
  return out;
}

function extractModels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MODEL_OVERRIDE_RE)) {
    out.push(m[1].toLowerCase());
  }
  return [...new Set(out)];
}

function similarSubjects(a: string, b: string): boolean {
  if (a === b) return true;
  // Take the first noun-ish token from each subject and compare.
  const head = (s: string) => s.split(/\s+/).slice(0, 2).join(" ");
  return head(a) === head(b);
}

function sameModelFamily(a: string, b: string): boolean {
  const family = (s: string) => s.split("-")[0];
  return family(a) === family(b);
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
}

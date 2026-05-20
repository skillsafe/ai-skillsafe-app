import { z } from "zod";

// Rule feed shipped from app.skillsafe.ai. One signed envelope, multiple
// payloads inside — minimizes fetch + verify overhead vs. per-feature feeds.
//
// The payload_digest field is SHA-256 over the JSON.stringify of `feeds` with
// stable key ordering (see canonicalFeeds() in client.ts). v1 verifies digest
// only; v2 will add a detached signature using the updater identity.

const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);

export const toxicSkillsPayloadSchema = z.object({
  version: z.string(),
  // Findings whose rule_id matches any of these patterns force the install
  // to abort. Glob-style: `reverse_shell_*` matches `reverse_shell_bash`.
  block_rules: z.array(z.string()),
  // Findings whose rule_id matches these install but get the quarantine
  // sentinel written to frontmatter — agents skip them on activation.
  quarantine_rules: z.array(z.string()),
});

export const mcpBlocklistEntrySchema = z.object({
  // Matches `name` of the McpServer when set.
  name: z.string().optional(),
  // Matches the stdio command (e.g. "npx", "uvx") when set.
  command: z.string().optional(),
  // ALL substrings must appear somewhere in the args array.
  args_contains: z.array(z.string()).optional(),
  reason: z.string(),
  severity: severitySchema,
});

export const mcpBlocklistPayloadSchema = z.object({
  version: z.string(),
  entries: z.array(mcpBlocklistEntrySchema),
});

export const secretsPathRuleSchema = z.object({
  // Plain substring or glob fragment ("\.env\b", "~/.aws/", "credentials.json").
  pattern: z.string(),
  reason: z.string(),
  severity: severitySchema,
});

export const secretsPathsPayloadSchema = z.object({
  version: z.string(),
  globs: z.array(secretsPathRuleSchema),
});

export const feedEnvelopeSchema = z.object({
  schema: z.literal(1),
  generated_at: z.string(),
  payload_digest: z.string(),
  feeds: z.object({
    "toxic-skills": toxicSkillsPayloadSchema,
    "mcp-blocklist": mcpBlocklistPayloadSchema,
    "secrets-paths": secretsPathsPayloadSchema,
  }),
});

export type FeedEnvelope = z.infer<typeof feedEnvelopeSchema>;
export type ToxicSkillsPayload = z.infer<typeof toxicSkillsPayloadSchema>;
export type McpBlocklistPayload = z.infer<typeof mcpBlocklistPayloadSchema>;
export type McpBlocklistEntry = z.infer<typeof mcpBlocklistEntrySchema>;
export type SecretsPathsPayload = z.infer<typeof secretsPathsPayloadSchema>;
export type Severity = z.infer<typeof severitySchema>;

export type FeedName = keyof FeedEnvelope["feeds"];
export type FeedPayload<N extends FeedName> = FeedEnvelope["feeds"][N];

// Built-in fallback used when no cached copy exists and the network fetch
// fails on first launch. Empty rule lists = no blocking, no quarantine, no
// warnings — fails open. Real curated rules ship through the feed once the
// device has connectivity.
export const FALLBACK_ENVELOPE: FeedEnvelope = {
  schema: 1,
  generated_at: "1970-01-01T00:00:00.000Z",
  payload_digest: "",
  feeds: {
    "toxic-skills": { version: "fallback", block_rules: [], quarantine_rules: [] },
    "mcp-blocklist": { version: "fallback", entries: [] },
    "secrets-paths": { version: "fallback", globs: [] },
  },
};

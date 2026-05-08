import { z } from "zod";

// Permission rule strings stay opaque (e.g. "Bash(git *)", "Read(/etc/**)").
// We don't try to parse the inner shape — Claude Code's matcher is the source
// of truth. Validation just confirms it's a non-empty string.
const ruleString = z.string().min(1);

export const permissionsSchema = z
  .object({
    allow: z.array(ruleString).optional(),
    deny: z.array(ruleString).optional(),
    ask: z.array(ruleString).optional(),
    defaultMode: z.enum(["auto", "ask", "deny", "allow"]).optional(),
  })
  .passthrough();

export type Permissions = z.infer<typeof permissionsSchema>;

// Hooks live under the same settings.json. Claude Code groups them by event;
// each event holds a list of matcher-scoped hook groups. The inner `hooks`
// list runs in order. Schema mirrors the docs at
// https://docs.claude.com/en/docs/claude-code/hooks.
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Notification",
  "UserPromptSubmit",
  "SubagentStop",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const hookCommandSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  timeout: z.number().int().positive().optional(),
});

export const hookGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(hookCommandSchema).min(1),
});

export const hooksSchema = z
  .record(z.enum(HOOK_EVENTS), z.array(hookGroupSchema))
  .optional();

export type HookGroup = z.infer<typeof hookGroupSchema>;
export type HookCommand = z.infer<typeof hookCommandSchema>;
export type Hooks = z.infer<typeof hooksSchema>;

// MCP servers come in two transports. `stdio` spawns a local process; `url`
// hits a remote HTTP/SSE server. The on-disk shape is `{ "<name>": <server> }`
// so the name is the object key, not a field.
export const mcpStdioServerSchema = z.object({
  type: z.literal("stdio").optional(), // older configs omit `type` for stdio
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const mcpUrlServerSchema = z.object({
  type: z.literal("url"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const mcpServerSchema = z.union([mcpStdioServerSchema, mcpUrlServerSchema]);
export type McpServer = z.infer<typeof mcpServerSchema>;

export const mcpFileSchema = z
  .object({
    mcpServers: z.record(z.string(), mcpServerSchema).optional(),
  })
  .passthrough();
export type McpFile = z.infer<typeof mcpFileSchema>;

// Keybindings file is sparsely documented. We capture a permissive shape and
// preserve unknown keys via _rest in the loader; the editor tab can show raw
// JSON for anything outside this schema.
export const keybindingSchema = z
  .object({
    action: z.string().min(1),
    keys: z.string().min(1),
    when: z.string().optional(),
  })
  .passthrough();

export const keybindingsFileSchema = z
  .object({
    bindings: z.array(keybindingSchema).optional(),
  })
  .passthrough();
export type Keybinding = z.infer<typeof keybindingSchema>;
export type KeybindingsFile = z.infer<typeof keybindingsFileSchema>;

// Inventory types for the Workbench view.
//
// The Workbench expands the artifact universe beyond {skills, agents,
// commands} (which keep their existing UI) to also cover the AI tool's
// memory files, MCP server registrations, hooks, permissions, and
// keybindings. Items are tool-scoped and category-tagged so the master
// store + future Transfer flow can match equivalents across tools.

export type StateCategory =
  | "skills"
  | "agents"
  | "commands"
  | "memory"
  | "mcp"
  | "hooks"
  | "permissions"
  | "keybindings"
  | "transcripts";

export type WorkbenchScope = "global" | "project";

export interface InventoryItem {
  /** Stable id: hash of (category|tool|scope|projectPath|name). */
  id: string;
  /** Registry agent key (claude, codex, cursor, …). */
  tool: string;
  category: StateCategory;
  scope: WorkbenchScope;
  /** null for global; absolute project path for project scope. */
  projectPath: string | null;
  /** Human-readable label (CLAUDE.md, "playwright" MCP, etc.). */
  name: string;
  /** Origin path on disk. */
  absPath: string;
  /** Category-specific JSON-serializable body. Renderers cast based on category. */
  payload: unknown;
  /** SHA-256 hex of canonicalized payload. */
  contentHash: string;
  /** Best-effort epoch ms; 0 when stat fails. */
  lastSeen: number;
  /**
   * Synthesized from a manifest entry whose live source is no longer on
   * disk (or never existed on this machine). Detail pane lazy-loads the
   * body from the master payload file rather than rescanning sources.
   */
  masterOnly?: boolean;
}

export interface InventorySnapshot {
  generatedAt: number;
  items: InventoryItem[];
  /** Tool keys we attempted to scan. */
  scannedTools: string[];
  /** Tool → human-readable error, when a surface read failed entirely. */
  errors: Record<string, string>;
}

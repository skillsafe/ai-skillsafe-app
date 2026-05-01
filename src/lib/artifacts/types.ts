export type Tool = "claude" | "codex" | "cursor" | "openclaw" | "cline" | "hermes";
// "all" is a UI-only sentinel that aggregates the concrete scopes; the lib
// itself never receives it (App.tsx fans it out into individual calls).
export type Scope = "global" | "project" | "lockfile" | "all";
export type ArtifactType = "skill" | "agent" | "command" | "all";

export interface Attachment {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  children?: Attachment[];
}

export interface MarkdownArtifact {
  id: string;
  tool: Tool;
  scope: Scope;
  type: ArtifactType;
  name: string;
  path: string;
  isBundle: boolean;
  bundleDir?: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  attachments: Attachment[];
  mtimeMs?: number;
  lockedHash?: string;
  computedHash?: string;
  drift?: boolean;
}

export interface ListOptions {
  tool: Tool;
  // ListOptions never carries "all"; App.tsx narrows before calling the loader.
  scope: Exclude<Scope, "all">;
  type: Exclude<ArtifactType, "all">;
  projectRoot?: string;
}

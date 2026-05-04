// Tool keys come from the registry in ../agents/registry.ts, which mirrors
// vercel-labs/skills' agents.ts. `Tool` is therefore "every agent npx skills
// supports" (plus our custom hermes entry). `string` here, not the strict
// keyof, because the union is large and the registry is the runtime source
// of truth — guards live in ../agents/registry.ts (isKnownAgent).
export type Tool = string;
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

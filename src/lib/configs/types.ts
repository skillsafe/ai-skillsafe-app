// Config files are structured-JSON siblings to the markdown artifacts under
// src/lib/artifacts/. They're not surfaced through the artifact UI because
// their schemas are nothing like skill/agent/command frontmatter — different
// editor, different file shape, fixed count per scope.

export type ConfigKind = "permissions" | "hooks" | "mcp" | "keybindings";

export type ConfigScope = "global" | "project";

// Inside a project, settings.json is split between two files. `local` is what
// individual users edit (gitignored); `shared` is checked into the repo so a
// team can pin the same hooks/permissions for everyone. Slice 1 surfaces both
// via a small toggle inside the project-scope editor.
export type ProjectSettingsTier = "local" | "shared";

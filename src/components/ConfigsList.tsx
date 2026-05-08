import { useApp } from "../lib/store";
import type { ConfigKind } from "../lib/configs/types";

interface KindRow {
  id: ConfigKind;
  label: string;
  description: string;
}

// File names per kind / scope are useful as a one-liner under each row so the
// user can see at a glance what the editor is going to touch.
const KINDS: KindRow[] = [
  {
    id: "permissions",
    label: "Permissions",
    description: "Allow / Deny / Ask rules + default mode",
  },
  {
    id: "hooks",
    label: "Hooks",
    description: "Run shell commands before/after tool use, on Stop, etc.",
  },
  {
    id: "mcp",
    label: "MCP servers",
    description: "Connect Claude Code to external MCP tools",
  },
  {
    id: "keybindings",
    label: "Keybindings",
    description: "Customize keyboard shortcuts",
  },
];

export function ConfigsList() {
  const configKind = useApp((s) => s.configKind);
  const setConfigKind = useApp((s) => s.setConfigKind);
  const scope = useApp((s) => s.scope);
  const tier = useApp((s) => s.projectSettingsTier);

  const effectiveScope: "global" | "project" = scope === "project" ? "project" : "global";
  return (
    <section className="list-pane configs-list">
      {KINDS.map((k) => {
        const isActive = configKind === k.id;
        return (
          <div
            key={k.id}
            className={`artifact-card ${isActive ? "active" : ""}`}
            onClick={() => setConfigKind(k.id)}
          >
            <div className="artifact-name">{k.label}</div>
            <div className="artifact-desc">{k.description}</div>
            <div className="artifact-meta">
              <span>{filenameFor(k.id, effectiveScope, tier)}</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function filenameFor(
  kind: ConfigKind,
  scope: "global" | "project",
  tier: "local" | "shared",
): string {
  if (kind === "keybindings") return "~/.claude/keybindings.json";
  if (kind === "mcp") {
    return scope === "global" ? "~/.claude/.mcp.json" : "<project>/.mcp.json";
  }
  // permissions + hooks both live in settings.json
  if (scope === "global") return "~/.claude/settings.json";
  return tier === "shared"
    ? "<project>/.claude/settings.json"
    : "<project>/.claude/settings.local.json";
}

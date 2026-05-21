import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { LocationHeader } from "./LocationHeader";
import type { ConfigKind } from "../lib/configs/types";

const KINDS: ConfigKind[] = ["permissions", "hooks", "mcp", "keybindings"];

export function ConfigsList() {
  const { t } = useTranslation();
  const configKind = useApp((s) => s.configKind);
  const setConfigKind = useApp((s) => s.setConfigKind);
  const scope = useApp((s) => s.scope);
  const tier = useApp((s) => s.projectSettingsTier);

  const labelFor: Record<ConfigKind, string> = {
    permissions: t("configsList.permissionsLabel"),
    hooks: t("configsList.hooksLabel"),
    mcp: t("configsList.mcpLabel"),
    keybindings: t("configsList.keybindingsLabel"),
  };
  const descFor: Record<ConfigKind, string> = {
    permissions: t("configsList.permissionsDesc"),
    hooks: t("configsList.hooksDesc"),
    mcp: t("configsList.mcpDesc"),
    keybindings: t("configsList.keybindingsDesc"),
  };

  const effectiveScope: "global" | "project" = scope === "project" ? "project" : "global";
  return (
    <section className="list-pane configs-list">
      <LocationHeader />
      {KINDS.map((k) => {
        const isActive = configKind === k;
        return (
          <div
            key={k}
            className={`artifact-card ${isActive ? "active" : ""}`}
            onClick={() => setConfigKind(k)}
          >
            <div className="artifact-name">{labelFor[k]}</div>
            <div className="artifact-desc">{descFor[k]}</div>
            <div className="artifact-meta">
              <span>{filenameFor(k, effectiveScope, tier)}</span>
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

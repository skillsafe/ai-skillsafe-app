import { useTranslation } from "react-i18next";
import { displayNameOf } from "../lib/agents/registry";
import { useApp } from "../lib/store";
import type { Broadening } from "../lib/filterCounts";
import type { Tool, Scope, ArtifactType } from "../lib/artifacts/types";

interface EmptyStateGuidanceProps {
  /** Where we are: which view called this, so the headline is right. */
  view: "artifacts" | "workbench" | "configs";
  tool: Tool;
  scope: Scope;
  type?: ArtifactType;
  category?: string | null;
  /** The current totals so we can detect "globally empty" vs "filtered empty". */
  totalAcrossAll: number;
  /** Ranked broadenings from useFilterCounts. */
  broadenings: ReadonlyArray<Broadening>;
  /** Optional create-new callback for the globally-empty fallback. */
  onCreateNew?: () => void;
  /** Optional browse-cloud callback for the globally-empty fallback. */
  onBrowseCloud?: () => void;
}

export function EmptyStateGuidance(props: EmptyStateGuidanceProps) {
  const { t } = useTranslation();
  const { setScope, setType, setTool, setWorkbenchCategory } = useApp.getState();
  const { view, tool, scope, type, category, totalAcrossAll, broadenings, onCreateNew, onBrowseCloud } = props;

  const typeLabel = type && type !== "all" ? t(`types.${type}`) : t("common.all").toLowerCase();
  const scopeLabel = t(`scopes.${scope}`);
  const toolLabel = displayNameOf(tool);

  const headline =
    totalAcrossAll === 0
      ? view === "configs"
        ? t("emptyGuidance.headlineConfigsEmpty", { tool: toolLabel, scope: scopeLabel })
        : t("emptyGuidance.headlineGloballyEmpty", { type: typeLabel })
      : view === "workbench"
        ? t("emptyGuidance.headlineFilteredMaster", { category: category ?? t("common.all"), tool: toolLabel })
        : t("emptyGuidance.headlineFiltered", { type: typeLabel, tool: toolLabel, scope: scopeLabel });

  const top = broadenings.slice(0, 3);

  return (
    <div className="empty empty-guidance">
      <div className="empty-guidance-headline">{headline}</div>
      {top.length > 0 && (
        <div className="empty-guidance-actions">
          {top.map((b, i) => {
            const apply = () => {
              if (b.kind === "scopeAll") setScope("all");
              else if (b.kind === "typeAll") setType("all");
              else if (b.kind === "categoryAll") setWorkbenchCategory(null);
              else if (b.kind === "switchTool" && b.tool) setTool(b.tool);
            };
            const label =
              b.kind === "scopeAll"
                ? t("emptyGuidance.broadenScopeAll", { delta: b.deltaCount })
                : b.kind === "typeAll"
                ? t("emptyGuidance.broadenTypeAll", { delta: b.deltaCount })
                : b.kind === "categoryAll"
                ? t("emptyGuidance.broadenCategoryAll", { delta: b.deltaCount })
                : t("emptyGuidance.broadenSwitchTool", { tool: displayNameOf(b.tool!), delta: b.deltaCount });
            return (
              <button key={i} className="link-btn" onClick={apply}>
                {label}
              </button>
            );
          })}
        </div>
      )}
      {totalAcrossAll === 0 && (onCreateNew || onBrowseCloud) && (
        <div className="empty-guidance-actions">
          {onCreateNew && (
            <button className="link-btn" onClick={onCreateNew}>{t("emptyGuidance.createNew")}</button>
          )}
          {onBrowseCloud && (
            <button className="link-btn" onClick={onBrowseCloud}>{t("emptyGuidance.browseCloud")}</button>
          )}
        </div>
      )}
    </div>
  );
}

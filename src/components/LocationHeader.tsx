import { useTranslation } from "react-i18next";
import { displayNameOf } from "../lib/agents/registry";
import { useApp } from "../lib/store";
import { useFilterCounts } from "../lib/hooks/useFilterCounts";
import type { ArtifactType, Scope } from "../lib/artifacts/types";

const SCOPES_CYCLE: Scope[] = ["all", "global", "project"];
const TYPES_CYCLE: ArtifactType[] = ["all", "skill", "agent", "command"];

function next<T>(cycle: T[], current: T): T {
  const idx = cycle.indexOf(current);
  return cycle[(idx + 1) % cycle.length];
}

export function LocationHeader() {
  const { t } = useTranslation();
  const view = useApp((s) => s.view);
  const tool = useApp((s) => s.tool);
  const scope = useApp((s) => s.scope);
  const type = useApp((s) => s.type);
  const workbenchCategory = useApp((s) => s.workbenchCategory);
  const setScope = useApp((s) => s.setScope);
  const setType = useApp((s) => s.setType);
  const setWorkbenchCategory = useApp((s) => s.setWorkbenchCategory);
  const counts = useFilterCounts();

  if (view === "configs") {
    return (
      <header className="location-header">
        <button className="loc-segment" type="button">{displayNameOf(tool)}</button>
        <span className="loc-sep">{t("navHeader.separator")}</span>
        <button
          className="loc-segment"
          type="button"
          onClick={() => setScope(next(["global", "project"] as Scope[], scope === "global" ? "global" : "project"))}
        >
          {t(`scopes.${scope === "global" ? "global" : "project"}`)}
        </button>
        <span className="loc-count">· {t("navHeader.itemsCount", { count: counts.total })}</span>
      </header>
    );
  }

  if (view === "workbench") {
    return (
      <header className="location-header">
        <button className="loc-segment loc-segment--master" type="button">{t("navHeader.master")}</button>
        <span className="loc-sep">{t("navHeader.separator")}</span>
        <button className="loc-segment" type="button">{displayNameOf(tool)}</button>
        <span className="loc-sep">{t("navHeader.separator")}</span>
        <button
          className="loc-segment"
          type="button"
          onClick={() => setWorkbenchCategory(null)}
          title={workbenchCategory ? t("emptyGuidance.broadenCategoryAllNoCount") : ""}
        >
          {workbenchCategory ? t(`masterCategories.${workbenchCategory}` as "masterCategories.all") : t("common.all")}
        </button>
        <span className="loc-count">· {t("navHeader.itemsCount", { count: counts.total })}</span>
      </header>
    );
  }

  // artifacts view
  return (
    <header className="location-header">
      <button className="loc-segment" type="button">{displayNameOf(tool)}</button>
      <span className="loc-sep">{t("navHeader.separator")}</span>
      <button
        className="loc-segment"
        type="button"
        onClick={() => setScope(next(SCOPES_CYCLE, scope))}
      >
        {t(`scopes.${scope}`)}
      </button>
      <span className="loc-sep">{t("navHeader.separator")}</span>
      <button
        className="loc-segment"
        type="button"
        onClick={() => setType(next(TYPES_CYCLE, type))}
      >
        {t(`types.${type}`)}
      </button>
      <span className="loc-count">· {t("navHeader.itemsCount", { count: counts.total })}</span>
    </header>
  );
}

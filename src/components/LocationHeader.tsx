import { useTranslation } from "react-i18next";
import { displayNameOf } from "../lib/agents/registry";
import { useApp } from "../lib/store";
import { useFilterCounts } from "../lib/hooks/useFilterCounts";
import type { ArtifactType, Scope } from "../lib/artifacts/types";

const SCOPES_CYCLE: Scope[] = ["all", "global", "project"];
const CONFIG_SCOPES_CYCLE: Scope[] = ["global", "project"];
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
  const sep = <span className="loc-sep" aria-hidden="true">{t("navHeader.separator")}</span>;

  if (view === "configs") {
    const effectiveScope: Scope = scope === "all" ? "global" : scope;
    return (
      <header className="location-header" role="navigation" aria-label={t("navHeader.youAreHere")}>
        <span className="loc-segment">{displayNameOf(tool)}</span>
        {sep}
        <button
          className="loc-segment loc-segment--interactive"
          type="button"
          onClick={() => setScope(next(CONFIG_SCOPES_CYCLE, effectiveScope))}
        >
          {t(`scopes.${effectiveScope}`)}
        </button>
      </header>
    );
  }

  if (view === "workbench") {
    return (
      <header className="location-header" role="navigation" aria-label={t("navHeader.youAreHere")}>
        <span className="loc-segment loc-segment--master">{t("navHeader.master")}</span>
        {sep}
        <span className="loc-segment">{displayNameOf(tool)}</span>
        {sep}
        <button
          className="loc-segment loc-segment--interactive"
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
    <header className="location-header" role="navigation" aria-label={t("navHeader.youAreHere")}>
      <span className="loc-segment">{displayNameOf(tool)}</span>
      {sep}
      <button
        className="loc-segment loc-segment--interactive"
        type="button"
        onClick={() => setScope(next(SCOPES_CYCLE, scope))}
      >
        {t(`scopes.${scope}`)}
      </button>
      {sep}
      <button
        className="loc-segment loc-segment--interactive"
        type="button"
        onClick={() => setType(next(TYPES_CYCLE, type))}
      >
        {t(`types.${type}`)}
      </button>
      <span className="loc-count">· {t("navHeader.itemsCount", { count: counts.total })}</span>
    </header>
  );
}

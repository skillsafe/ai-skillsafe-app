import { useMemo } from "react";
import { useApp } from "../store";
import { computeFilterCounts, type FilterCountsOutput } from "../filterCounts";

export function useFilterCounts(): FilterCountsOutput {
  const view = useApp((s) => s.view);
  const tool = useApp((s) => s.tool);
  const scope = useApp((s) => s.scope);
  const type = useApp((s) => s.type);
  const category = useApp((s) => s.category);
  const workbenchCategory = useApp((s) => s.workbenchCategory);
  const projectFilter = useApp((s) => s.projectFilter);
  const artifacts = useApp((s) => s.artifacts);
  const workbenchInventory = useApp((s) => s.workbenchInventory);

  return useMemo(
    () =>
      computeFilterCounts({
        view,
        tool,
        scope,
        type,
        category: view === "workbench" ? workbenchCategory : category,
        projectFilter,
        artifacts,
        workbenchInventory,
      }),
    [view, tool, scope, type, category, workbenchCategory, projectFilter, artifacts, workbenchInventory],
  );
}

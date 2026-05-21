import type { ArtifactType, MarkdownArtifact, Scope, Tool } from "./artifacts/types";
import type { InventorySnapshot } from "./inventory/types";
import type { View } from "./store";

export interface FilterCountsInput {
  view: View;
  tool: Tool;
  scope: Scope;
  type: ArtifactType;
  category: string | null;
  projectFilter: string | null;
  artifacts: MarkdownArtifact[];
  workbenchInventory: InventorySnapshot | null;
}

export type BroadeningKind =
  | "scopeAll"
  | "typeAll"
  | "categoryAll"
  | "switchTool";

export interface Broadening {
  kind: BroadeningKind;
  deltaCount: number;
  tool?: Tool; // present when kind === "switchTool"
}

export interface FilterCountsOutput {
  byScope: { all: number; global: number; project: number };
  byType: { all: number; skill: number; agent: number; command: number } | null;
  byCategory: Record<string, number> | null;
  byTool: Map<Tool, number> | null;
  total: number;
  broadenings: Broadening[];
}

function scopeMatch(a: MarkdownArtifact, scope: Scope): boolean {
  return scope === "all" || a.scope === scope;
}

function typeMatch(a: MarkdownArtifact, type: ArtifactType): boolean {
  return type === "all" || a.type === type;
}

export function computeFilterCounts(input: FilterCountsInput): FilterCountsOutput {
  const { view, tool, scope, type, category, artifacts, workbenchInventory } = input;

  // --- byScope: from artifacts, holding type fixed
  const byScope = {
    all: artifacts.filter((a) => typeMatch(a, type)).length,
    global: artifacts.filter((a) => a.scope === "global" && typeMatch(a, type)).length,
    project: artifacts.filter((a) => a.scope === "project" && typeMatch(a, type)).length,
  };

  // --- byType: Artifacts view only
  let byType: FilterCountsOutput["byType"] = null;
  if (view === "artifacts") {
    byType = {
      all: artifacts.filter((a) => scopeMatch(a, scope)).length,
      skill: artifacts.filter((a) => a.type === "skill" && scopeMatch(a, scope)).length,
      agent: artifacts.filter((a) => a.type === "agent" && scopeMatch(a, scope)).length,
      command: artifacts.filter((a) => a.type === "command" && scopeMatch(a, scope)).length,
    };
  }

  // --- byCategory: Workbench view only, from inventory
  let byCategory: FilterCountsOutput["byCategory"] = null;
  if (view === "workbench" && workbenchInventory) {
    const counts: Record<string, number> = { all: 0 };
    for (const it of workbenchInventory.items) {
      if (it.tool !== tool) continue;
      if (scope !== "all" && it.scope !== scope) continue;
      counts[it.category] = (counts[it.category] ?? 0) + 1;
      counts.all += 1;
    }
    byCategory = counts;
  } else if (view === "workbench") {
    byCategory = { all: 0 };
  }

  // --- byTool: from workbench inventory across all tools, holding nothing else
  let byTool: Map<Tool, number> | null = null;
  if (workbenchInventory) {
    byTool = new Map();
    for (const it of workbenchInventory.items) {
      byTool.set(it.tool, (byTool.get(it.tool) ?? 0) + 1);
    }
  }

  // --- total: items the user is currently seeing
  let total = 0;
  if (view === "artifacts") {
    total = artifacts.filter((a) => scopeMatch(a, scope) && typeMatch(a, type)).length;
  } else if (view === "workbench" && workbenchInventory) {
    total = workbenchInventory.items.filter((it) => {
      if (it.tool !== tool) return false;
      if (scope !== "all" && it.scope !== scope) return false;
      if (category && it.category !== category) return false;
      return true;
    }).length;
  }

  // --- broadenings: only when current view is empty
  const broadenings: Broadening[] = [];
  if (total === 0) {
    if (view === "artifacts") {
      if (scope !== "all" && byScope.all > 0) {
        broadenings.push({ kind: "scopeAll", deltaCount: byScope.all });
      }
      if (type !== "all" && byType && byType.all > 0) {
        broadenings.push({ kind: "typeAll", deltaCount: byType.all });
      }
      if (byTool) {
        for (const [t, count] of byTool) {
          if (t === tool) continue;
          if (count > 0) broadenings.push({ kind: "switchTool", deltaCount: count, tool: t });
        }
      }
    } else if (view === "workbench") {
      if (category !== null) {
        const allCount = byCategory?.all ?? 0;
        if (allCount > 0) broadenings.push({ kind: "categoryAll", deltaCount: allCount });
      }
      if (scope !== "all" && byCategory && (byCategory.all ?? 0) === 0 && workbenchInventory) {
        const allScopes = workbenchInventory.items.filter((it) => it.tool === tool).length;
        if (allScopes > 0) broadenings.push({ kind: "scopeAll", deltaCount: allScopes });
      }
      if (byTool) {
        for (const [t, count] of byTool) {
          if (t === tool) continue;
          if (count > 0) broadenings.push({ kind: "switchTool", deltaCount: count, tool: t });
        }
      }
    }
    broadenings.sort((a, b) => b.deltaCount - a.deltaCount);
  }

  return { byScope, byType, byCategory, byTool, total, broadenings };
}

import { describe, expect, it } from "vitest";
import { computeFilterCounts, type FilterCountsInput } from "../src/lib/filterCounts";
import type { MarkdownArtifact } from "../src/lib/artifacts/types";
import type { InventorySnapshot, InventoryItem } from "../src/lib/inventory/types";

function art(over: Partial<MarkdownArtifact> = {}): MarkdownArtifact {
  return {
    id: `a-${Math.random()}`,
    name: "x",
    tool: "claude",
    scope: "global",
    type: "skill",
    path: "/x",
    frontmatter: {},
    body: "",
    ...(over as any),
  };
}

function inv(items: InventoryItem[]): InventorySnapshot {
  return { items, generatedAt: Date.now(), scannedTools: [], errors: {} };
}

describe("computeFilterCounts", () => {
  it("returns total = artifacts.length and byType/byScope from artifacts in Artifacts view", () => {
    const artifacts = [
      art({ type: "skill", scope: "global" }),
      art({ type: "skill", scope: "global" }),
      art({ type: "agent", scope: "project" }),
    ];
    const input: FilterCountsInput = {
      view: "artifacts",
      tool: "claude",
      scope: "all",
      type: "all",
      category: null,
      projectFilter: null,
      artifacts,
      workbenchInventory: null,
    };
    const out = computeFilterCounts(input);
    expect(out.total).toBe(3);
    expect(out.byType).toEqual({ all: 3, skill: 2, agent: 1, command: 0 });
    expect(out.byScope).toEqual({ all: 3, global: 2, project: 1 });
    expect(out.byTool).toBeNull();
    expect(out.byCategory).toBeNull();
  });

  it("byTool comes from workbenchInventory; null when inventory not loaded", () => {
    const inventory = inv([
      { id: "1", tool: "claude", scope: "global", category: "skills" } as InventoryItem,
      { id: "2", tool: "claude", scope: "global", category: "memory" } as InventoryItem,
      { id: "3", tool: "cursor", scope: "global", category: "skills" } as InventoryItem,
    ]);
    const out = computeFilterCounts({
      view: "artifacts",
      tool: "claude",
      scope: "all",
      type: "all",
      category: null,
      projectFilter: null,
      artifacts: [],
      workbenchInventory: inventory,
    });
    expect(out.byTool?.get("claude")).toBe(2);
    expect(out.byTool?.get("cursor")).toBe(1);

    const out2 = computeFilterCounts({
      view: "artifacts",
      tool: "claude",
      scope: "all",
      type: "all",
      category: null,
      projectFilter: null,
      artifacts: [],
      workbenchInventory: null,
    });
    expect(out2.byTool).toBeNull();
  });

  it("Workbench view exposes byCategory and nulls byType", () => {
    const inventory = inv([
      { id: "1", tool: "claude", scope: "global", category: "memory" } as InventoryItem,
      { id: "2", tool: "claude", scope: "global", category: "memory" } as InventoryItem,
      { id: "3", tool: "claude", scope: "global", category: "mcp" } as InventoryItem,
    ]);
    const out = computeFilterCounts({
      view: "workbench",
      tool: "claude",
      scope: "global",
      type: "all",
      category: null,
      projectFilter: null,
      artifacts: [],
      workbenchInventory: inventory,
    });
    expect(out.byType).toBeNull();
    expect(out.byCategory).toBeDefined();
    expect(out.byCategory?.memory).toBe(2);
    expect(out.byCategory?.mcp).toBe(1);
  });

  it("Configs view nulls both byType and byCategory", () => {
    const out = computeFilterCounts({
      view: "configs",
      tool: "claude",
      scope: "global",
      type: "all",
      category: null,
      projectFilter: null,
      artifacts: [],
      workbenchInventory: null,
    });
    expect(out.byType).toBeNull();
    expect(out.byCategory).toBeNull();
  });

  it("broadenings are ranked by deltaCount descending", () => {
    // current: type=skill, scope=global, 0 matches in current filter
    // broadening "type=all" yields +5, "scope=all" yields +8 → scope wins
    const artifacts = [
      art({ type: "agent", scope: "global" }),
      art({ type: "agent", scope: "global" }),
      art({ type: "agent", scope: "global" }),
      art({ type: "agent", scope: "global" }),
      art({ type: "agent", scope: "global" }),
      art({ type: "skill", scope: "project" }),
      art({ type: "skill", scope: "project" }),
      art({ type: "skill", scope: "project" }),
      art({ type: "skill", scope: "project" }),
      art({ type: "skill", scope: "project" }),
      art({ type: "skill", scope: "project" }),
      art({ type: "skill", scope: "project" }),
      art({ type: "skill", scope: "project" }),
    ];
    const out = computeFilterCounts({
      view: "artifacts",
      tool: "claude",
      scope: "global",
      type: "skill",
      category: null,
      projectFilter: null,
      artifacts,
      workbenchInventory: null,
    });
    expect(out.total).toBe(0);
    expect(out.broadenings.length).toBeGreaterThan(0);
    expect(out.broadenings[0].deltaCount).toBeGreaterThanOrEqual(out.broadenings[1]?.deltaCount ?? 0);
    expect(out.broadenings[0].kind).toBe("scopeAll");
  });

  it("returns empty broadenings when current filter is already non-empty", () => {
    const out = computeFilterCounts({
      view: "artifacts",
      tool: "claude",
      scope: "global",
      type: "all",
      category: null,
      projectFilter: null,
      artifacts: [art({ type: "skill", scope: "global" })],
      workbenchInventory: null,
    });
    expect(out.total).toBe(1);
    expect(out.broadenings).toEqual([]);
  });
});

# Navigation Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sticky "you are here" breadcrumb header, live counts on every sidebar pill, and contextual empty-state guidance with ranked broadening actions — without changing the Tool × Scope × Type filter model.

**Architecture:** One pure derivation function (`computeFilterCounts`) wrapped in one React hook (`useFilterCounts`) feeds three consumers: a new `LocationHeader`, augmented sidebar pills via a new `PillCount` badge, and a new `EmptyStateGuidance` block. Cross-tool counts piggyback on the existing `workbenchInventory` store field. Graceful degradation when inventory hasn't loaded yet.

**Tech Stack:** Tauri 2 + React 19 + TypeScript, Zustand store (`useApp`), Vitest unit tests (no `@testing-library/react` in this repo — component behavior is verified through the existing `scripts/ui-driver/` Playwright runner), i18next with 6 locales (en, de, es, fr, ja, zh-CN).

**Spec:** `docs/superpowers/specs/2026-05-21-navigation-clarity-design.md`

---

## File map

**Create:**
- `src/lib/filterCounts.ts` — pure derivation function `computeFilterCounts(input)`.
- `src/lib/hooks/useFilterCounts.ts` — thin React hook that memoizes the pure function over store state.
- `src/components/PillCount.tsx` — `<span>` badge component.
- `src/components/EmptyStateGuidance.tsx` — contextual empty-state block with broadening buttons.
- `src/components/LocationHeader.tsx` — sticky breadcrumb above the main pane.
- `tests/filterCounts.test.ts` — unit tests for the pure function.
- `scripts/ui-driver/scenarios/nav-clarity-empty.mjs` — UI-driver scenario for the empty-state broadening flow.
- `scripts/ui-driver/scenarios/nav-clarity-master.mjs` — UI-driver scenario for Master view header.

**Modify:**
- `src/i18n/locales/en.json` — add `navHeader`, `pillCounts`, `emptyGuidance` namespaces.
- `src/i18n/locales/{de,es,fr,ja,zh-CN}.json` — add the same keys; English fallback acceptable for first ship.
- `src/components/Sidebar.tsx` — render `<PillCount>` inside each scope, type, master-category, and eligible-category pill.
- `src/components/ArtifactList.tsx` — replace the one-line empty (`L173–177`) with `<EmptyStateGuidance>`.
- `src/components/InventoryList.tsx` — replace the empty block (`L99–108`) with `<EmptyStateGuidance>`.
- `src/App.tsx` — mount `<LocationHeader />` above the main pane; add a one-shot workbench-inventory warm-up effect.
- `src/styles.css` — styles for `.location-header`, `.pill-count`, `.pill-count--empty`, `.empty-guidance`.

---

## Task 1: Add i18n keys

**Files:**
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/de.json`, `es.json`, `fr.json`, `ja.json`, `zh-CN.json` (copy English strings as placeholders — locale translation is a follow-up)

- [ ] **Step 1: Add the three new namespaces to `en.json`**

Append these blocks at the top level (alongside existing `sidebar`, `artifactList`, etc.). Order inside the file is not significant; place them after the existing `artifactList` block for proximity to the strings they relate to.

```json
"navHeader": {
  "separator": "›",
  "itemsCount": "{count, plural, one {# item} other {# items}}",
  "tool": "{tool}",
  "scope": "{scope}",
  "type": "{type}",
  "master": "Master",
  "category": "{category}"
},
"pillCounts": {
  "label": "{count, number}"
},
"emptyGuidance": {
  "headlineFiltered": "No {type} match {tool} × {scope}.",
  "headlineFilteredMaster": "No items in {category} for {tool}.",
  "headlineGloballyEmpty": "No {type} exist in any tool.",
  "headlineConfigsEmpty": "No configs for {tool} × {scope}.",
  "broadenScopeAll": "Show all scopes (+{delta})",
  "broadenTypeAll": "Clear Type filter (+{delta})",
  "broadenSwitchTool": "Switch to {tool} (+{delta})",
  "broadenCategoryAll": "Show all categories (+{delta})",
  "broadenScopeAllNoCount": "Show all scopes",
  "broadenTypeAllNoCount": "Clear Type filter",
  "broadenCategoryAllNoCount": "Show all categories",
  "createNew": "Create new",
  "browseCloud": "Browse cloud"
}
```

- [ ] **Step 2: Mirror the same keys in the 5 other locale files**

For `de.json`, `es.json`, `fr.json`, `ja.json`, `zh-CN.json`: paste the **exact same English values** for now. Translation is a separate workstream — i18next falls back to English when a key is missing, but having the keys present (even with English text) keeps every locale's structure parallel and lints from CI clean.

- [ ] **Step 3: Run typecheck and tests**

```bash
npm run typecheck
npm test
```

Expected: PASS (no code changed yet, just JSON).

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "i18n: navigation-clarity strings (en + 5 locale stubs)"
```

---

## Task 2: `computeFilterCounts` pure function (TDD)

**Files:**
- Create: `src/lib/filterCounts.ts`
- Test: `tests/filterCounts.test.ts`

**Rationale:** Keeping the derivation pure (no React, no store) means we test it in plain Vitest like the rest of the codebase. The hook in Task 3 is a thin wrapper.

- [ ] **Step 1: Write the failing tests**

Create `tests/filterCounts.test.ts`:

```ts
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
  return { items, generatedAt: new Date().toISOString() };
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/filterCounts.test.ts
```

Expected: FAIL with `Cannot find module '../src/lib/filterCounts'`.

- [ ] **Step 3: Implement the pure function**

Create `src/lib/filterCounts.ts`:

```ts
import type { ArtifactType, MarkdownArtifact, Scope, Tool } from "./artifacts/types";
import type { InventorySnapshot, StateCategory } from "./inventory/types";
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/filterCounts.test.ts
```

Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/filterCounts.ts tests/filterCounts.test.ts
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "feat(nav): pure computeFilterCounts derivation + unit tests"
```

---

## Task 3: `useFilterCounts` hook

**Files:**
- Create: `src/lib/hooks/useFilterCounts.ts`

- [ ] **Step 1: Write the hook**

Create `src/lib/hooks/useFilterCounts.ts`:

```ts
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
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `workbenchCategory` selector signature mismatches, open `src/lib/store.ts`, find the `workbenchCategory` field declaration, and adjust the selector type accordingly.

- [ ] **Step 3: Commit**

```bash
git add src/lib/hooks/useFilterCounts.ts
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "feat(nav): useFilterCounts hook wrapping the pure derivation"
```

---

## Task 4: `PillCount` component + CSS

**Files:**
- Create: `src/components/PillCount.tsx`
- Modify: `src/styles.css` (append at end of file)

- [ ] **Step 1: Create the component**

`src/components/PillCount.tsx`:

```tsx
import type { ReactElement } from "react";

interface PillCountProps {
  /** Render the badge only when count is a number; passing null hides it. */
  count: number | null | undefined;
}

export function PillCount({ count }: PillCountProps): ReactElement | null {
  if (count === null || count === undefined) return null;
  const empty = count === 0;
  return (
    <span className={`pill-count${empty ? " pill-count--empty" : ""}`} aria-hidden="true">
      {count}
    </span>
  );
}
```

- [ ] **Step 2: Append styles to `src/styles.css`**

```css
.pill-count {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 0.78em;
  font-variant-numeric: tabular-nums;
  background: var(--pill-count-bg, rgba(255, 255, 255, 0.08));
  color: var(--pill-count-fg, currentColor);
  line-height: 1.4;
  min-width: 1.4em;
  text-align: center;
}
.pill-count--empty {
  opacity: 0.45;
}
.pill.active .pill-count {
  background: rgba(255, 255, 255, 0.18);
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/PillCount.tsx src/styles.css
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "feat(nav): PillCount badge component + styles"
```

---

## Task 5: Wire `PillCount` into Sidebar pills

**Files:**
- Modify: `src/components/Sidebar.tsx`

The sidebar today renders scope pills around line 229, type/master-category pills around line 326, and eligible-category pills around line 371 (see `Sidebar.tsx`). Each needs a `<PillCount count={...} />` child after its label.

- [ ] **Step 1: Import the hook and component at the top of `Sidebar.tsx`**

Add after the existing imports near the top:

```tsx
import { PillCount } from "./PillCount";
import { useFilterCounts } from "../lib/hooks/useFilterCounts";
```

- [ ] **Step 2: Call the hook inside `Sidebar()` near the other hook calls**

After the `useApp(...)` destructure block (around line 70), add:

```tsx
const counts = useFilterCounts();
```

- [ ] **Step 3: Inject `<PillCount>` into the scope pills**

In the scope-pill `.map` (around line 229), change the label-only button content from:

```tsx
{t(`scopes.${s}`)}
```

to:

```tsx
{t(`scopes.${s}`)}
<PillCount count={s === "all" ? counts.byScope.all : s === "global" ? counts.byScope.global : s === "project" ? counts.byScope.project : null} />
```

(`lockfile` scope appears in the `Scope` type but is filtered out by the visible `SCOPES` array — the conditional returns `null` defensively for any unhandled value.)

- [ ] **Step 4: Inject `<PillCount>` into the type pills**

In the `TYPES.map` block (around line 353), change:

```tsx
{t(`types.${tt}`)}
```

to:

```tsx
{t(`types.${tt}`)}
<PillCount count={counts.byType ? (counts.byType as any)[tt] : null} />
```

- [ ] **Step 5: Inject `<PillCount>` into the master-category pills**

In the `MASTER_CATEGORIES.filter(...).map(...)` block (around line 333), change:

```tsx
{t(`masterCategories.${mc}`)}
```

to:

```tsx
{t(`masterCategories.${mc}`)}
<PillCount count={counts.byCategory ? counts.byCategory[mc] ?? 0 : null} />
```

- [ ] **Step 6: Inject `<PillCount>` into the eligible-category pills**

In the `eligibleCategories.map((dt) => {...})` block (around line 371), change the trailing button content from:

```tsx
{label}
```

to:

```tsx
{label}
<PillCount count={counts.byCategory ? counts.byCategory[dt.id] ?? 0 : null} />
```

- [ ] **Step 7: Run typecheck and tests**

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/Sidebar.tsx
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "feat(nav): live counts on every sidebar pill"
```

---

## Task 6: `EmptyStateGuidance` component

**Files:**
- Create: `src/components/EmptyStateGuidance.tsx`
- Modify: `src/styles.css` (append)

- [ ] **Step 1: Create the component**

`src/components/EmptyStateGuidance.tsx`:

```tsx
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
```

- [ ] **Step 2: Append styles to `src/styles.css`**

```css
.empty-guidance {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 24px;
  text-align: center;
}
.empty-guidance-headline {
  font-size: 0.95em;
  opacity: 0.85;
}
.empty-guidance-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.empty-guidance-actions .link-btn {
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
}
.empty-guidance-actions .link-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/EmptyStateGuidance.tsx src/styles.css
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "feat(nav): EmptyStateGuidance component with ranked broadenings"
```

---

## Task 7: Replace empty states in `ArtifactList` and `InventoryList`

**Files:**
- Modify: `src/components/ArtifactList.tsx`
- Modify: `src/components/InventoryList.tsx`

- [ ] **Step 1: Replace `ArtifactList` empty block**

Open `src/components/ArtifactList.tsx`. Around line 173–177 you'll find:

```tsx
{filtered.length === 0 ? (
  <div className="empty">
    {artifacts.length === 0 ? t("artifactList.noArtifacts") : t("artifactList.noMatches")}
    {error && <div className="empty-error">{error}</div>}
  </div>
) : (
```

Replace with:

```tsx
{filtered.length === 0 ? (
  <>
    <EmptyStateGuidance
      view="artifacts"
      tool={tool}
      scope={scope}
      type={type}
      totalAcrossAll={counts.byScope.all}
      broadenings={counts.broadenings}
    />
    {error && <div className="empty empty-error">{error}</div>}
  </>
) : (
```

Add imports at the top of the file:

```tsx
import { EmptyStateGuidance } from "./EmptyStateGuidance";
import { useFilterCounts } from "../lib/hooks/useFilterCounts";
```

Inside the component, near the other store reads, add (if `tool`, `scope`, `type` aren't already destructured locally — check existing imports first; they almost certainly come from `useApp`):

```tsx
const counts = useFilterCounts();
```

- [ ] **Step 2: Replace `InventoryList` empty block**

Open `src/components/InventoryList.tsx`. Around lines 99–108 you'll find:

```tsx
{error && <div className="empty empty-error">{t("inventoryList.scanFailed", { error })}</div>}
{filteredItems.length === 0 && !error && (
  <div className="empty">
    {workbenchInventory.items.length === 0
      ? t("inventoryList.emptyOnDisk")
      : t("inventoryList.noMatches")}
  </div>
)}
```

Replace the second block (the `!error && (...)` part) with:

```tsx
{filteredItems.length === 0 && !error && (
  <EmptyStateGuidance
    view="workbench"
    tool={tool}
    scope={scope}
    category={workbenchCategory}
    totalAcrossAll={workbenchInventory.items.filter((it) => it.tool === tool).length}
    broadenings={counts.broadenings}
  />
)}
```

Add imports and the `counts` hook call at the top of the component, same as Task 7 Step 1.

- [ ] **Step 3: Typecheck and run tests**

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ArtifactList.tsx src/components/InventoryList.tsx
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "feat(nav): empty-state guidance with broadening actions"
```

---

## Task 8: `LocationHeader` component

**Files:**
- Create: `src/components/LocationHeader.tsx`
- Modify: `src/styles.css` (append)

The header is a sticky breadcrumb. Initial version uses simple cycle-through buttons (no popovers) — this is sufficient because the sidebar's existing pills are the primary picker, and the header is the indicator. A follow-up can add popovers if user testing shows clicking the segments is a common path.

- [ ] **Step 1: Create the component**

`src/components/LocationHeader.tsx`:

```tsx
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
          {workbenchCategory ? t(`masterCategories.${workbenchCategory}`) : t("common.all")}
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
```

- [ ] **Step 2: Append styles to `src/styles.css`**

```css
.location-header {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--header-bg, rgba(20, 20, 20, 0.85));
  backdrop-filter: blur(8px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 0.9em;
}
.loc-segment {
  background: transparent;
  border: 0;
  padding: 4px 8px;
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.loc-segment:hover {
  background: rgba(255, 255, 255, 0.08);
}
.loc-segment--master {
  font-weight: 600;
}
.loc-sep {
  opacity: 0.5;
}
.loc-count {
  margin-left: auto;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/LocationHeader.tsx src/styles.css
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "feat(nav): LocationHeader sticky breadcrumb component"
```

---

## Task 9: Mount `LocationHeader` inside each list component

**Files:**
- Modify: `src/components/ArtifactList.tsx`
- Modify: `src/components/InventoryList.tsx`
- Modify: `src/components/ConfigsList.tsx`

**Rationale:** `App.tsx` lays out the app in a CSS grid (sidebar, list column, editor column are separate grid cells). Adding `LocationHeader` as another grid child would consume its own row/column. The cleanest mount is inside each list component, as the first child of its root `<section className="list-pane">`. `position: sticky` then pins it to the top of the list column while the list itself scrolls.

- [ ] **Step 1: Mount in `ArtifactList`**

In `src/components/ArtifactList.tsx`, add the import at the top:

```tsx
import { LocationHeader } from "./LocationHeader";
```

The root element is at line 136: `<section className="list-pane">`. Make `<LocationHeader />` the first child:

```tsx
return (
  <section className="list-pane">
    <LocationHeader />
    <div className="list-toolbar">
      ...
```

- [ ] **Step 2: Mount in `InventoryList`**

Same change in `src/components/InventoryList.tsx`. Find the root element of the component's render output and insert `<LocationHeader />` as its first child:

```bash
grep -n "return (\|<section\|<div className=\"list-pane" src/components/InventoryList.tsx | head -5
```

Add the import and the JSX node analogously to Step 1.

- [ ] **Step 3: Mount in `ConfigsList`**

Same change in `src/components/ConfigsList.tsx`. Confirm its root element with:

```bash
grep -n "return (\|<section\|<div className=\"list-pane" src/components/ConfigsList.tsx | head -5
```

Add the import and the JSX node analogously.

- [ ] **Step 4: Run dev server and verify visually**

```bash
cd /Users/xhu/home/Research/H.HI1H/dev/skillsafe-app && ./start_dev.sh --skip-build
```

In the desktop window: the breadcrumb appears at the top of the list column in each view. Switch between Artifacts / Workbench / Configs and verify it changes shape correctly (Configs hides the Type segment; Workbench shows `Master › Tool › Category`).

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/ArtifactList.tsx src/components/InventoryList.tsx src/components/ConfigsList.tsx
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "feat(nav): mount LocationHeader at the top of each list pane"
```

---

## Task 10: Background workbench inventory warm-up

The spec says Tool counts on pills should populate within a second or two of launch — but `useWorkbenchData` only scans when `view === "workbench"`. We add a small effect that triggers a single warm-up scan on app mount if `workbenchInventory` is still null.

**Files:**
- Modify: `src/lib/hooks/useWorkbenchData.ts`

- [ ] **Step 1: Inspect the existing scan call**

```bash
grep -n "view !== \"workbench\"" src/lib/hooks/useWorkbenchData.ts
```

You'll see the early return on line ~37. We're going to allow a single warm-up pass when `workbenchInventory` is null, even if the view isn't workbench. The scan is exactly the same; we just trigger it once.

- [ ] **Step 2: Modify the effect's guard**

In `src/lib/hooks/useWorkbenchData.ts`, change the start of the effect from:

```tsx
useEffect(() => {
  if (view !== "workbench") return;
  let cancelled = false;
```

to:

```tsx
const haveInventory = useApp((s) => s.workbenchInventory !== null);

useEffect(() => {
  // Run on workbench view, OR once as a warm-up so Tool counts populate
  // on the sidebar pills before the user opens Workbench.
  if (view !== "workbench" && haveInventory) return;
  let cancelled = false;
```

(The `haveInventory` selector goes alongside the other `useApp` selectors at the top of the hook function — before any `useMemo` or `useEffect`.)

- [ ] **Step 3: Run typecheck and tests**

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 4: Manual smoke**

```bash
cd /Users/xhu/home/Research/H.HI1H/dev/skillsafe-app && ./start_dev.sh --skip-build
```

After app launches, observe that Tool counts appear on the pills within a few seconds (the warm-up scan runs in background).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hooks/useWorkbenchData.ts
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "feat(nav): warm up workbench inventory on app mount for pill counts"
```

---

## Task 11: UI-driver scenarios

**Files:**
- Create: `scripts/ui-driver/scenarios/nav-clarity-empty.mjs`
- Create: `scripts/ui-driver/scenarios/nav-clarity-master.mjs`

These exercise the real Tauri build through the existing UI driver. They serve as integration smoke tests.

- [ ] **Step 1: Inspect an existing UI-driver scenario to mirror style**

```bash
ls scripts/ui-driver/scenarios/ | head -5
cat scripts/ui-driver/scenarios/$(ls scripts/ui-driver/scenarios/ | head -1)
```

The runner exposes helpers like `await driver.click(selector)`, `await driver.expectVisible(selector)`. Use the same pattern in the new scenarios.

- [ ] **Step 2: Write `nav-clarity-empty.mjs`**

```javascript
// Verifies EmptyStateGuidance + broadening flow.
// Picks a tool/scope combo that yields zero artifacts, asserts the
// guidance block renders, clicks "Show all scopes", asserts the list
// is no longer empty.

export const name = "nav-clarity-empty";

export async function run(driver) {
  await driver.click('[aria-labelledby="sidebar-scope-label"] [role="tab"]:nth-child(2)'); // Global
  await driver.click('[aria-labelledby="sidebar-type-label"] [role="tab"]:nth-child(4)'); // Command
  await driver.click('.tool-select'); // open tool dropdown
  // Pick an unlikely-to-have-commands tool. Aider-Desk works as a stable choice in CI.
  await driver.selectOption('.tool-select', 'aider-desk');

  await driver.expectVisible('.empty-guidance');
  await driver.expectVisible('.empty-guidance-headline');

  // The first broadening should be "Show all scopes (+N)" — click it
  await driver.click('.empty-guidance-actions .link-btn:first-child');

  // After broadening, either the list has rows or the guidance updates
  // with a different broadening. Both prove the flow works; we check
  // that the LocationHeader's count updated above zero.
  await driver.expectTextMatches('.loc-count', /\d+ items?/);
}
```

- [ ] **Step 3: Write `nav-clarity-master.mjs`**

```javascript
// Verifies LocationHeader in Workbench/Master mode.

export const name = "nav-clarity-master";

export async function run(driver) {
  await driver.click('.pill[title]'); // Master pill
  await driver.expectVisible('.location-header .loc-segment--master');
  await driver.expectTextMatches('.location-header', /Master/);
  await driver.expectTextMatches('.loc-count', /\d+ items?/);
}
```

- [ ] **Step 4: Run the scenarios**

```bash
npm run tauri:drive &
sleep 30  # wait for tauri dev to come up
npm run ui-drive -- nav-clarity-empty
npm run ui-drive -- nav-clarity-master
```

Expected: both scenarios PASS. If a scenario fails because the selectors drifted (`.pill`, `.tool-select`, etc.), update the selector to match the current sidebar markup.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui-driver/scenarios/nav-clarity-empty.mjs scripts/ui-driver/scenarios/nav-clarity-master.mjs
git -c user.name=jeremie-strand -c user.email='269871107+jeremie-strand@users.noreply.github.com' commit -m "test(nav): UI-driver scenarios for empty-state + Master header"
```

---

## Task 12: Final verification + release-prep commit

- [ ] **Step 1: Full test + typecheck + build**

```bash
npm run typecheck && npm test && npm run build
```

Expected: all PASS. If `npm run build` fails on i18n key validation, double-check Task 1's locale stubs are complete in all 6 files.

- [ ] **Step 2: Manual smoke (golden path + the 4 edge cases the spec calls out)**

```bash
cd /Users/xhu/home/Research/H.HI1H/dev/skillsafe-app && ./start_dev.sh --skip-build
```

In the app window, verify:
- LocationHeader is visible at top of main pane and changes as you switch view / tool / scope / type.
- Pill counts appear next to every scope, type, master-category, and eligible-category label.
- Tool counts on the tool dropdown options appear within ~5 seconds of launch.
- Pick a known-empty tool × scope × type combo → EmptyStateGuidance appears with at least one broadening button → click it → list populates and header count updates.
- Switch into Master view → header reads `Master › <tool> › <category> · N items`.
- Switch into Configs view → Type segment is hidden in the header.

- [ ] **Step 3: Tag-prep commit (no version bump — that's a separate workflow)**

```bash
git log --oneline -15
```

Verify the commit chain reads like a coherent feature. No final commit needed unless you discovered a smoke-test fix.

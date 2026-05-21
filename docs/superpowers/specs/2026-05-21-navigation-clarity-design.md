# Navigation Clarity: "You Are Here" Signaling

**Date:** 2026-05-21
**Status:** Approved — ready for implementation plan
**Scope:** `ai-skillsafe-app/` (desktop app)

## Problem

The app filters every list by **Tool × Scope × Type** simultaneously (with a Master/Workbench pivot that swaps Type for Category). The three filters are presented as separate pill rows in the sidebar with no aggregated indicator of the active combination and no live counts.

Two observed pains:

1. **"What am I looking at?"** — Users lose track of the current Tool × Scope × Type while moving through the app. The pill rows are a *control surface*, not a *state readout*; reconstructing the active combination requires scanning three separate rows.
2. **"Why is this empty?"** — When a filter combo yields nothing, `ArtifactList` renders a single line: `"no artifacts"` / `"no matches"`. The user can't tell whether the category is genuinely empty or merely filtered out, and has no path back to a non-empty state short of trial-and-error pill toggling.

The 3-axis filter model is correct (it mirrors how artifacts live on disk: per-tool directories with global/project scope). This spec is about **signaling the model better**, not changing it.

## Goal

The user should always be able to answer, at a glance:

- Where am I in the filter space? *(Tool × Scope × Type, plus item count.)*
- What else is one click away? *(Counts on every alternative.)*
- If this is empty, why — and how do I get to non-empty? *(Explained empty state with ranked broadening actions.)*

Non-goals: changing the filter model, restructuring the sidebar, rewriting the artifact scan, or replacing the existing Workbench/Master pivot.

## Architecture

Three layers, plumbed through one new hook so the sidebar and the new header share a single source of truth for counts. No state-shape changes to `useApp`.

```
src/
├─ components/
│  ├─ LocationHeader.tsx        (new — sticky breadcrumb above the main pane)
│  ├─ EmptyStateGuidance.tsx    (new — replaces the one-line empty state)
│  ├─ Sidebar.tsx               (modified — pills render counts via PillCount)
│  ├─ ArtifactList.tsx          (modified — uses EmptyStateGuidance)
│  ├─ ConfigsList.tsx           (modified — same)
│  └─ InventoryList.tsx         (modified — Master/Workbench mode)
└─ lib/
   └─ hooks/
      └─ useFilterCounts.ts     (new — single source of truth for counts)
```

`App.tsx` mounts `<LocationHeader />` just above whichever list view is active (Artifacts / Configs / Workbench), so the header is universal but contextual.

## Components

### `LocationHeader`

One row, ~40px tall, pinned to the top of the main pane via CSS `position: sticky` so it stays visible while the list scrolls. Renders three breadcrumb segments plus a trailing item count:

```
Claude Code › Global › Skills · 12 items
```

Each segment is a `<button>` that opens a small popover anchored under the segment. Popovers reuse the same option lists the sidebar already maintains (tool registry, scope set, type set) but render as their own popover instance — they don't try to drive the sidebar's existing dropdown from a different DOM node. Selecting an option calls the same store setter the sidebar pills call, so both surfaces stay in sync. The trailing count is plain text.

View-specific behavior:
- **Workbench / Master view:** segments swap to `Master › Memory · 4 items` (matches the existing sidebar pivot — the Type row already swaps to master categories in that mode).
- **Configs view:** the Type segment is hidden (configs don't have a Type axis).

### `PillCount`

A tiny inline badge — `<span class="pill-count">12</span>` — that each existing pill renders alongside its label. Zero counts apply `.pill-count--empty` (muted color) but the pill stays clickable so the user can verify. When the count for an axis is unknown (e.g. workbench inventory not yet loaded), the badge is omitted entirely rather than rendering `0`.

### `EmptyStateGuidance`

Replaces the current one-line empty in `ArtifactList`, `ConfigsList`, and `InventoryList`. Three render modes:

1. **Filtered-empty (something exists nearby):**
   ```
   No skills match Claude Code × Global.
   [Show all scopes (+8)]  [Switch to Cursor (+5)]  [Clear Type filter (+2)]
   ```
   Up to 3 broadening buttons, ranked by `deltaCount` descending. Each button invokes the relevant store setter.

2. **Truly empty (nothing exists anywhere):**
   ```
   No skills exist in any tool.
   [Create new]  [Browse cloud]
   ```

3. **Unknown nearby state (workbench inventory not loaded):**
   ```
   No skills match Claude Code × Global.
   [Show all scopes]  [Clear Type filter]
   ```
   Drops the cross-tool suggestion, keeps Scope/Type broadenings derived from the current scan.

### `useFilterCounts(state)`

Pure derivation hook. Single source of truth for all count displays.

```ts
input:  { artifacts, workbenchInventory, view, tool, scope, type, category, projectFilter }
output: {
  byScope:    { all: N, global: N, project: N },           // from artifacts
  byType:     { all: N, skill: N, agent: N, command: N }   // Artifacts view only
              | null,                                       // null in Configs / Workbench view
  byCategory: { all: N, memory: N, mcp: N, hooks: N, … }   // Workbench/Master view only
              | null,                                       // null elsewhere
  byTool:     Map<Tool, number> | null,                    // from workbenchInventory; null if not loaded
  total:      N,
  broadenings: Array<{ label, deltaCount, apply: () => void }>
}
```

The hook switches between `byType` and `byCategory` based on the current `view` — Artifacts view exposes `byType`, Workbench/Master view exposes `byCategory`, Configs view exposes neither. Consumers (`LocationHeader`, `Sidebar`, `EmptyStateGuidance`) read whichever is non-null for their current context.

Memoized via `useMemo` on its inputs. Given the same inputs it always returns the same output.

## Data flow

The Tool axis is the only hard part — today `artifacts` in the store is the result of scanning *one* `tool × scope`. To show counts on other tools' pills, we need cross-tool knowledge.

We reuse two existing data sources:

1. **`useApp.artifacts`** — the current scan. Provides accurate counts for the current tool's Scope and Type pills, plus the LocationHeader's total. Free.
2. **`useApp.workbenchInventory`** — when populated, this is already a cross-tool, cross-category index produced by the Workbench scan. We piggyback on it for **Tool** pill counts and for the empty-state's "Switch to Cursor (+5)" suggestion.

If workbench inventory hasn't been populated yet (user has never opened Workbench), Tool counts gracefully omit — pills render without the `· N` badge instead of showing zeros. A small background `refreshInventoryIfStale()` call kicks off on app mount so first-render counts arrive within a second or two. No new IPC, no new scan paths.

## Error handling and edge cases

- **Workbench inventory not loaded.** Tool counts return `null` from the hook; pills render without the badge, LocationHeader still shows the current-tool total, EmptyStateGuidance drops the cross-tool suggestion but keeps Scope/Type broadenings. No spinner, no error — silent graceful degradation.
- **Scan in flight.** Counts derive from whatever's currently in the store, so during a scan they reflect the pre-scan state for a beat, then update. The existing `loading` flag continues to drive the list's spinner — counts don't double-spinner.
- **Stale workbench inventory.** A "Switch to Cursor (+5)" button could be wrong if Cursor's actual count changed since the last workbench scan. After the click, the normal scan against Cursor runs and the resulting list (and any new empty state) is authoritative. No retry loop and no special "stale count" indicator — the next render corrects itself.
- **Master / Workbench view.** LocationHeader and EmptyStateGuidance read from `workbenchInventory` (not `artifacts`) when in that view; the hook handles the branch and exposes `byCategory` instead of `byType` (see the hook signature above).
- **Configs view.** Type axis doesn't exist; the hook returns `byType: null` and LocationHeader hides that segment.
- **i18n.** All new strings (`"X items"`, `"No skills match"`, broadening labels) get keys in the existing `t()` table and translations for the 6 supported locales (en/es/fr/de/zh-CN/ja). Plurals use ICU MessageFormat (already in use).

## Testing

### Unit (Vitest)

- `useFilterCounts.test.ts` — synthetic `{ artifacts, workbenchInventory, tool, scope, type, projectFilter }` in, assert output. Cases: empty artifacts, single-tool, multi-tool, no workbench inventory (Tool counts null), Master view, Configs view (Type null), broadening ranking is deterministic.
- `EmptyStateGuidance.test.tsx` — given a counts object, assert correct headline + the right 0–3 broadening buttons in the right order. Click handler invokes the right store action.
- `PillCount.test.tsx` — renders `· N`, applies `.pill-count--empty` when N=0, omits the badge when N is `null`.

### Component-level

- `Sidebar.test.tsx` — one new test per pill row asserting counts render against a mocked store. Existing tests must continue to pass unmodified (no regressions on pill click / aria).
- `LocationHeader.test.tsx` — renders the three segments and total for a given store state; clicking Scope cycles correctly; segments hide as expected in Configs / Master views.

### UI driver (`scripts/ui-driver/`)

- Launch app, pick a tool/scope combo known to be empty → assert `EmptyStateGuidance` is visible with the expected broadening buttons → click "Show all scopes" → assert list now has rows and LocationHeader's Scope segment updated.
- Switch into Master view → assert LocationHeader text matches `Master › <category> · N items`.

### Manual smoke

- First-launch state where workbench inventory hasn't populated → Tool counts gracefully missing on pills, present on Scope/Type pills.
- Switch tools, watch counts update.
- Force a filter combo to be empty → empty-state guidance appears → broadening button restores a non-empty list.

## Out of scope

- Restructuring the filter model (e.g. making Type the primary axis instead of Tool). The user explicitly opted to preserve the existing structure.
- Global search / jump-to / command palette. Real friction, but a separate spec — different code paths, different UX paradigm.
- Onboarding / first-launch tutorial. Also real, also separate.
- Sidebar visual redesign beyond adding `PillCount` badges.

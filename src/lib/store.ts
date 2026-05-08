import { create } from "zustand";
import type { Attachment, ArtifactType, MarkdownArtifact, Scope, Tool } from "./artifacts/types";
import { isKnownAgent } from "./agents/registry";
import type { CloudAccount } from "./skillsafe/types";
import type { ScanReport } from "./skillsafe/client";
import type { BackupStats } from "./backup/manifest";
import type { BackupProgress } from "./backup/runBackup";
import type { ScheduleSpec } from "./backup/generateScripts";
import {
  defaultDataTypeIdsFor,
  defaultEnabledExtraSourceIds,
  isExtraSource,
  normalizeDataTypeIds,
} from "./backup/dataTypes";
import type { UpdateProgress } from "./update/runner";
import { clearApiKey, loadApiKey, storeApiKey } from "./skillsafe/auth";
import type { ConfigKind, ProjectSettingsTier } from "./configs/types";

declare const __APP_VERSION__: string;

export type View = "artifacts" | "configs";

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export type RemoteFilter = "all" | "private" | "shared" | "public";
export type BottomPanel = "cloud" | "backup" | null;

export interface DiffEntryRef {
  absPath: string;
  entryId: string;
}

export interface ViewedFile {
  name: string;
  path: string;
  content: string;
  language: string;
}

const THEME_KEY = "skill-manager.theme";
const RECENT_TOOLS_KEY = "skill-manager.recentTools";
const CLOUD_OPEN_KEY = "skill-manager.cloudOpen";
const BOTTOM_PANEL_KEY = "skill-manager.bottomPanel";
const DEFAULT_TOOL_KEY = "skill-manager.defaultTool";
const DEFAULT_SCOPE_KEY = "skill-manager.defaultScope";
const REMOTE_FILTER_KEY = "skill-manager.remoteFilter";
const RECENT_PROJECTS_KEY = "skill-manager.recentProjects";
const PROJECT_ROOT_KEY = "skill-manager.projectRoot";
const PROJECT_FILTER_KEY = "skill-manager.projectFilter";
const BACKUP_DEST_KEY = "skill-manager.backupDestination";
const BACKUP_LAST_RUN_KEY = "skill-manager.backupLastRun";
const BACKUP_STATS_KEY = "skill-manager.backupStats";
const BACKUP_TOOLS_KEY = "skill-manager.backupTools";
// Tracks which default-on extra sources we've already seeded so a user who
// unchecks one isn't fighting the migration on every launch.
const BACKUP_TOOLS_SEEDED_KEY = "skill-manager.backupToolsSeeded";
const BACKUP_DATA_TYPES_KEY = "skill-manager.backupDataTypes";
const BACKUP_SCHEDULE_KEY = "skill-manager.backupSchedule";
const LAYOUT_KEY = "skill-manager.layout";
const AUTO_UPDATE_KEY = "skill-manager.autoUpdate";
const DISMISSED_UPDATE_KEY = "skill-manager.dismissedUpdateVersion";
const VIEW_KEY = "skill-manager.view";
const CONFIG_KIND_KEY = "skill-manager.configKind";
const PROJECT_SETTINGS_TIER_KEY = "skill-manager.projectSettingsTier";
const MAX_RECENT_TOOLS = 3;
const MAX_RECENT_PROJECTS = 12;
// Tool validation now defers to the registry — see ./agents/registry.ts.
// `isValidTool` lets the persisted tool list (recent tools, backup tools,
// default tool) accept any agent npx skills knows about.
const isValidTool = (t: unknown): t is Tool =>
  typeof t === "string" && (isKnownAgent(t) || isExtraSource(t));
const VALID_SCOPES: ReadonlyArray<Scope> = ["all", "global", "project", "lockfile"];

type LocalStorageLike = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};
type MediaQueryLike = { matches: boolean };
const browser = globalThis as {
  localStorage?: LocalStorageLike;
  matchMedia?: (q: string) => MediaQueryLike;
};

function initialTheme(): Theme {
  const saved = browser.localStorage?.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light" || saved === "system") return saved;
  return "system";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return browser.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

function initialRecentTools(initial: Tool): Tool[] {
  const raw = browser.localStorage?.getItem(RECENT_TOOLS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter(isValidTool);
        if (filtered.length > 0) return filtered.slice(0, MAX_RECENT_TOOLS);
      }
    } catch {
      // fall through
    }
  }
  return [initial];
}

function initialDefaultTool(): Tool {
  const v = browser.localStorage?.getItem(DEFAULT_TOOL_KEY);
  return isValidTool(v) ? v : "claude";
}

function initialDefaultScope(): Scope {
  const v = browser.localStorage?.getItem(DEFAULT_SCOPE_KEY);
  // The Lockfile pill was retired (it overlapped with Project); silently
  // upgrade old persisted values so the user isn't stuck on a hidden scope.
  if (v === "lockfile") return "project";
  // First launch (no persisted value) lands on "All" so the user sees every
  // installed artifact at once instead of an empty Global view.
  return VALID_SCOPES.includes(v as Scope) ? (v as Scope) : "all";
}

function initialBottomPanel(): BottomPanel {
  // Read the new key first; fall back to the legacy boolean so existing
  // sessions don't lose their cloud panel after upgrade.
  const v = browser.localStorage?.getItem(BOTTOM_PANEL_KEY);
  if (v === "cloud" || v === "backup") return v;
  if (v === "null" || v === null || v === undefined || v === "") {
    if (browser.localStorage?.getItem(CLOUD_OPEN_KEY) === "1") return "cloud";
  }
  return null;
}

function initialRecentProjects(): string[] {
  const raw = browser.localStorage?.getItem(RECENT_PROJECTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((p): p is string => typeof p === "string").slice(0, MAX_RECENT_PROJECTS);
    }
  } catch { /* ignore */ }
  return [];
}

function initialProjectRoot(): string | null {
  const v = browser.localStorage?.getItem(PROJECT_ROOT_KEY);
  return typeof v === "string" && v ? v : null;
}

function initialProjectFilter(): string | null {
  const v = browser.localStorage?.getItem(PROJECT_FILTER_KEY);
  return typeof v === "string" && v ? v : null;
}

function initialBackupDestination(): string | null {
  const v = browser.localStorage?.getItem(BACKUP_DEST_KEY);
  return typeof v === "string" && v ? v : null;
}

function initialBackupLastRun(): number | null {
  const v = browser.localStorage?.getItem(BACKUP_LAST_RUN_KEY);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function initialBackupStats(): BackupStats | null {
  const raw = browser.localStorage?.getItem(BACKUP_STATS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.counts) return parsed as BackupStats;
  } catch { /* ignore */ }
  return null;
}

function initialBackupSchedule(): ScheduleSpec {
  const raw = browser.localStorage?.getItem(BACKUP_SCHEDULE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.hour === "number" && typeof parsed.minute === "number") {
        const weekdays = Array.isArray(parsed.weekdays)
          ? parsed.weekdays.filter((n: unknown): n is number => typeof n === "number")
          : null;
        return { hour: parsed.hour, minute: parsed.minute, weekdays };
      }
    } catch { /* ignore */ }
  }
  return { hour: 12, minute: 15, weekdays: null };
}

// Resizable-divider defaults. Sidebar / list-pane widths are pixels; the
// horizontal split between top and bottom rows is a percentage of the window
// height so it stays sensible across resizes.
export const DEFAULT_LAYOUT = { col1: 260, col2: 320, rowPct: 50 };
const LAYOUT_BOUNDS = {
  col1: { min: 160, max: 480 },
  col2: { min: 200, max: 560 },
  rowPct: { min: 18, max: 82 },
};
export interface LayoutDividers {
  col1: number;
  col2: number;
  rowPct: number;
}

function clampLayout(v: Partial<LayoutDividers>): LayoutDividers {
  const get = (key: keyof LayoutDividers) => {
    const raw = v[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LAYOUT[key];
    return Math.max(LAYOUT_BOUNDS[key].min, Math.min(LAYOUT_BOUNDS[key].max, raw));
  };
  return { col1: get("col1"), col2: get("col2"), rowPct: get("rowPct") };
}

function initialLayout(): LayoutDividers {
  const raw = browser.localStorage?.getItem(LAYOUT_KEY);
  if (!raw) return { ...DEFAULT_LAYOUT };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return clampLayout(parsed as Partial<LayoutDividers>);
  } catch { /* ignore */ }
  return { ...DEFAULT_LAYOUT };
}

function initialBackupTools(): Tool[] {
  const raw = browser.localStorage?.getItem(BACKUP_TOOLS_KEY);
  let tools: Tool[];
  if (!raw) {
    tools = ["claude"];
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter(isValidTool);
        tools = filtered.length > 0 ? filtered : ["claude"];
      } else {
        tools = ["claude"];
      }
    } catch {
      tools = ["claude"];
    }
  }
  // First-launch / version-bump migration: merge in default-enabled extra
  // sources only the first time we see them. After this runs once, the
  // user's saved list is authoritative — they can uncheck and the change
  // sticks.
  const seenRaw = browser.localStorage?.getItem(BACKUP_TOOLS_SEEDED_KEY) ?? "";
  const seen = new Set(seenRaw.split(",").filter(Boolean));
  const defaults = defaultEnabledExtraSourceIds();
  let mutated = false;
  for (const id of defaults) {
    if (seen.has(id)) continue;
    if (!tools.includes(id)) {
      tools.push(id);
      mutated = true;
    }
    seen.add(id);
  }
  if (mutated || seen.size !== seenRaw.split(",").filter(Boolean).length) {
    browser.localStorage?.setItem(BACKUP_TOOLS_SEEDED_KEY, Array.from(seen).join(","));
    if (mutated) {
      browser.localStorage?.setItem(BACKUP_TOOLS_KEY, JSON.stringify(tools));
    }
  }
  return tools;
}

function initialBackupDataTypes(tools: Tool[]): Record<Tool, string[]> {
  const raw = browser.localStorage?.getItem(BACKUP_DATA_TYPES_KEY);
  const out: Record<Tool, string[]> = {};
  // Migration path: any tool selected without a saved data-type list gets the
  // registry's default-enabled set, preserving prior behavior (the script
  // backed up a tool's whole config root, which roughly maps to "all default
  // data types on").
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [tool, ids] of Object.entries(parsed as Record<string, unknown>)) {
          if (!isValidTool(tool)) continue;
          if (!Array.isArray(ids)) continue;
          const stringIds = ids.filter((s): s is string => typeof s === "string");
          out[tool] = normalizeDataTypeIds(tool, stringIds);
        }
      }
    } catch { /* ignore */ }
  }
  for (const tool of tools) {
    if (!(tool in out)) out[tool] = defaultDataTypeIdsFor(tool);
  }
  return out;
}

function initialRemoteFilter(): RemoteFilter {
  const v = browser.localStorage?.getItem(REMOTE_FILTER_KEY);
  // "mine" was the old label for the private+shared union — now resurrected
  // as "all" so users can see every skill they own in one list.
  if (v === "mine") return "all";
  if (v === "all" || v === "private" || v === "shared" || v === "public") return v;
  return "all";
}

function initialAutoUpdate(): boolean {
  const v = browser.localStorage?.getItem(AUTO_UPDATE_KEY);
  // Default ON — only "0" turns it off.
  return v !== "0";
}

function initialDismissedUpdate(): string | null {
  return browser.localStorage?.getItem(DISMISSED_UPDATE_KEY) ?? null;
}

function initialView(): View {
  const v = browser.localStorage?.getItem(VIEW_KEY);
  return v === "configs" ? "configs" : "artifacts";
}

const VALID_CONFIG_KINDS: ReadonlyArray<ConfigKind> = [
  "permissions",
  "hooks",
  "mcp",
  "keybindings",
];

function initialConfigKind(): ConfigKind {
  const v = browser.localStorage?.getItem(CONFIG_KIND_KEY);
  return VALID_CONFIG_KINDS.includes(v as ConfigKind) ? (v as ConfigKind) : "permissions";
}

function initialProjectSettingsTier(): ProjectSettingsTier {
  const v = browser.localStorage?.getItem(PROJECT_SETTINGS_TIER_KEY);
  return v === "shared" ? "shared" : "local";
}

function detectAppVersion(): string {
  // Vite injects this at build time (see vite.config.ts).
  if (typeof __APP_VERSION__ !== "undefined") return __APP_VERSION__;
  return "0.0.0";
}

function bumpRecent(list: Tool[], tool: Tool): Tool[] {
  const next = [tool, ...list.filter((t) => t !== tool)].slice(0, MAX_RECENT_TOOLS);
  browser.localStorage?.setItem(RECENT_TOOLS_KEY, JSON.stringify(next));
  return next;
}

interface AppState {
  tool: Tool;
  scope: Scope;
  type: ArtifactType;
  projectRoot: string | null;
  recentProjects: string[]; // newest-first list of folders the user has worked with
  // null = show artifacts from every project; otherwise narrows the
  // project-scope reload to a single root.
  projectFilter: string | null;
  artifacts: MarkdownArtifact[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  driftByName: Record<string, boolean>;
  viewedFile: ViewedFile | null;
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  recentTools: Tool[];
  cloudApiKey: string | null;
  cloudAccount: CloudAccount | null;

  // Cloud / remote panel
  cloudOpen: boolean;
  // Which bottom-row panel is showing: "cloud" (skillsafe.ai), "backup"
  // (local backup browser), or null (no bottom panel — single-row layout).
  bottomPanel: BottomPanel;
  remoteFilter: RemoteFilter;
  remoteQuery: string;
  remoteSort: string;
  remoteArtifacts: MarkdownArtifact[];
  remoteSelectedId: string | null;
  remoteLoading: boolean;
  remoteError: string | null;
  // Caches are keyed by `${artifactId}@${version}` so the user can switch
  // between published versions of the same skill without losing already-fetched
  // content.
  remoteBodyCache: Record<string, string>;
  remoteAttachmentsCache: Record<string, Attachment[]>;
  remotePathToHash: Record<string, Record<string, string>>;
  remoteSelectedVersion: Record<string, string>; // artifactId → version
  remoteVersionsCache: Record<string, string[]>; // artifactId → list of versions, newest first
  remoteFailedKeys: Record<string, string>; // cacheKey → error message; presence prevents retry
  remoteScanCache: Record<string, ScanReport | null>; // cacheKey → publisher scan report (or null = none)
  remoteHasMore: boolean; // cursor-based pagination for the public catalog
  remoteNextCursor: string | null;
  remoteLoadingMore: boolean;
  remoteViewedFile: ViewedFile | null;
  installedRemoteIds: string[];

  // Configs view (sibling to Artifacts) — settings.json/.mcp.json/keybindings.json
  view: View;
  configKind: ConfigKind;
  // Inside project scope, settings.json is split into a checked-in `shared`
  // file and a gitignored `local` file. The toggle persists per-user.
  projectSettingsTier: ProjectSettingsTier;

  // Settings
  showSettings: boolean;
  // When set, SettingsDialog scrolls this element id into view on mount and clears it.
  settingsScrollTarget: string | null;
  defaultTool: Tool;
  defaultScope: Scope;

  // Layout (resizable dividers)
  layout: LayoutDividers;

  // Backup
  backupDestination: string | null;
  backupLastRun: number | null;
  backupStats: BackupStats | null;
  backupBusy: boolean;
  backupProgress: BackupProgress | null;
  backupTools: Tool[];
  backupDataTypes: Record<Tool, string[]>;
  backupSchedule: ScheduleSpec;

  // In-app file editing + history (Editor.tsx drives editDirty so the parent
  // can guard navigation; the panel/overlay state lives here so HistoryPanel
  // and DiffView can be sibling renders rather than nested children).
  editDirty: boolean;
  historyPanelPath: string | null;
  diffEntry: DiffEntryRef | null;

  // Auto-update
  autoUpdate: boolean;
  currentVersion: string;
  availableUpdate: { version: string; notes: string; date?: string } | null;
  updateProgress: UpdateProgress | null;
  updateError: string | null;
  updateReadyToInstall: boolean;
  dismissedUpdateVersion: string | null;
  showUpdateDialog: boolean;

  setCloudAuth: (key: string | null, account: CloudAccount | null) => void;
  setCloudAccount: (account: CloudAccount | null) => void;
  setTool: (t: Tool) => void;
  setScope: (s: Scope) => void;
  setType: (t: ArtifactType) => void;
  setProjectRoot: (p: string | null) => void;
  setProjectFilter: (p: string | null) => void;
  removeRecentProject: (p: string) => void;
  setArtifacts: (a: MarkdownArtifact[]) => void;
  setSelectedId: (id: string | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setDrift: (d: Record<string, boolean>) => void;
  patchArtifact: (a: MarkdownArtifact) => void;
  removeArtifact: (id: string) => void;
  setViewedFile: (v: ViewedFile | null) => void;
  setTheme: (t: Theme) => void;
  setResolvedTheme: (t: ResolvedTheme) => void;

  setCloudOpen: (b: boolean) => void;
  toggleCloudOpen: () => void;
  setBottomPanel: (p: BottomPanel) => void;
  setRemoteFilter: (f: RemoteFilter) => void;
  setRemoteQuery: (q: string) => void;
  setRemoteSort: (s: string) => void;
  setRemoteArtifacts: (a: MarkdownArtifact[]) => void;
  setRemoteSelectedId: (id: string | null) => void;
  setRemoteLoading: (b: boolean) => void;
  setRemoteError: (e: string | null) => void;
  cacheRemoteBody: (
    cacheKey: string,
    body: string,
    attachments: Attachment[],
    pathToHash: Record<string, string>,
  ) => void;
  setRemoteSelectedVersion: (artifactId: string, version: string) => void;
  cacheRemoteVersions: (artifactId: string, versions: string[]) => void;
  markRemoteFailed: (cacheKey: string, message: string) => void;
  cacheRemoteScan: (cacheKey: string, report: ScanReport | null) => void;
  patchRemoteArtifactFrontmatter: (id: string, patch: Record<string, unknown>) => void;
  appendRemoteArtifacts: (a: MarkdownArtifact[]) => void;
  setRemoteHasMore: (b: boolean) => void;
  setRemoteNextCursor: (c: string | null) => void;
  setRemoteLoadingMore: (b: boolean) => void;
  setRemoteViewedFile: (v: ViewedFile | null) => void;
  markRemoteInstalled: (id: string) => void;

  setView: (v: View) => void;
  setConfigKind: (k: ConfigKind) => void;
  setProjectSettingsTier: (t: ProjectSettingsTier) => void;

  setShowSettings: (b: boolean) => void;
  setSettingsScrollTarget: (id: string | null) => void;
  setDefaultTool: (t: Tool) => void;
  setDefaultScope: (s: Scope) => void;

  setLayout: (next: Partial<LayoutDividers>) => void;
  resetLayout: () => void;

  setBackupDestination: (p: string | null) => void;
  setBackupResult: (lastRun: number, stats: BackupStats) => void;
  setBackupBusy: (b: boolean) => void;
  setBackupProgress: (p: BackupProgress | null) => void;
  setBackupTools: (tools: Tool[]) => void;
  setBackupDataTypes: (tool: Tool, ids: string[]) => void;
  setBackupSchedule: (s: ScheduleSpec) => void;

  setEditDirty: (b: boolean) => void;
  openHistoryPanel: (absPath: string) => void;
  closeHistoryPanel: () => void;
  openDiffEntry: (ref: DiffEntryRef) => void;
  closeDiffEntry: () => void;

  setAutoUpdate: (b: boolean) => void;
  setAvailableUpdate: (u: { version: string; notes: string; date?: string } | null) => void;
  setUpdateProgress: (p: UpdateProgress | null) => void;
  setUpdateError: (e: string | null) => void;
  setUpdateReadyToInstall: (b: boolean) => void;
  setDismissedUpdateVersion: (v: string | null) => void;
  setShowUpdateDialog: (b: boolean) => void;
}

export const useApp = create<AppState>((set) => ({
  tool: initialDefaultTool(),
  // Same upgrade path for the active scope — lockfile is no longer a UI option.
  scope: initialDefaultScope(),
  // Type isn't persisted, so each launch starts on "All". Matches the
  // first-launch default for scope above.
  type: "all",
  projectRoot: initialProjectRoot(),
  recentProjects: initialRecentProjects(),
  projectFilter: initialProjectFilter(),
  artifacts: [],
  selectedId: null,
  loading: false,
  error: null,
  driftByName: {},
  viewedFile: null,
  theme: initialTheme(),
  resolvedTheme: resolveTheme(initialTheme()),
  recentTools: initialRecentTools(initialDefaultTool()),
  cloudApiKey: loadApiKey(),
  cloudAccount: null,

  cloudOpen: initialBottomPanel() === "cloud",
  bottomPanel: initialBottomPanel(),
  remoteFilter: initialRemoteFilter(),
  remoteQuery: "",
  remoteSort: "popular",
  remoteArtifacts: [],
  remoteSelectedId: null,
  remoteLoading: false,
  remoteError: null,
  remoteBodyCache: {},
  remoteAttachmentsCache: {},
  remotePathToHash: {},
  remoteSelectedVersion: {},
  remoteVersionsCache: {},
  remoteFailedKeys: {},
  remoteScanCache: {},
  remoteHasMore: false,
  remoteNextCursor: null,
  remoteLoadingMore: false,
  remoteViewedFile: null,
  installedRemoteIds: [],

  view: initialView(),
  configKind: initialConfigKind(),
  projectSettingsTier: initialProjectSettingsTier(),

  showSettings: false,
  settingsScrollTarget: null,
  defaultTool: initialDefaultTool(),
  defaultScope: initialDefaultScope(),

  layout: initialLayout(),

  backupDestination: initialBackupDestination(),
  backupLastRun: initialBackupLastRun(),
  backupStats: initialBackupStats(),
  backupBusy: false,
  backupProgress: null,
  backupTools: initialBackupTools(),
  backupDataTypes: initialBackupDataTypes(initialBackupTools()),
  backupSchedule: initialBackupSchedule(),

  editDirty: false,
  historyPanelPath: null,
  diffEntry: null,

  autoUpdate: initialAutoUpdate(),
  currentVersion: detectAppVersion(),
  availableUpdate: null,
  updateProgress: null,
  updateError: null,
  updateReadyToInstall: false,
  dismissedUpdateVersion: initialDismissedUpdate(),
  showUpdateDialog: false,

  setCloudAuth: (cloudApiKey, cloudAccount) => {
    if (cloudApiKey) storeApiKey(cloudApiKey);
    else clearApiKey();
    set({ cloudApiKey, cloudAccount });
  },
  setCloudAccount: (cloudAccount) => set({ cloudAccount }),
  setTool: (tool) =>
    set((state) => ({
      tool,
      selectedId: null,
      viewedFile: null,
      recentTools: bumpRecent(state.recentTools, tool),
    })),
  setScope: (scope) => set({ scope, selectedId: null, viewedFile: null }),
  setType: (type) => set({ type, selectedId: null, viewedFile: null }),
  setProjectRoot: (projectRoot) =>
    set((state) => {
      // Persist last-used so reopening the app restores it without explicit pick.
      if (projectRoot) browser.localStorage?.setItem(PROJECT_ROOT_KEY, projectRoot);
      else browser.localStorage?.removeItem(PROJECT_ROOT_KEY);

      let recentProjects = state.recentProjects;
      if (projectRoot) {
        recentProjects = [
          projectRoot,
          ...state.recentProjects.filter((p) => p !== projectRoot),
        ].slice(0, MAX_RECENT_PROJECTS);
        browser.localStorage?.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recentProjects));
      }
      return { projectRoot, recentProjects };
    }),
  setProjectFilter: (projectFilter) => {
    if (projectFilter) browser.localStorage?.setItem(PROJECT_FILTER_KEY, projectFilter);
    else browser.localStorage?.removeItem(PROJECT_FILTER_KEY);
    set({ projectFilter, selectedId: null });
  },
  removeRecentProject: (p) =>
    set((state) => {
      const recentProjects = state.recentProjects.filter((x) => x !== p);
      browser.localStorage?.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recentProjects));
      const projectRoot = state.projectRoot === p ? null : state.projectRoot;
      if (state.projectRoot === p) browser.localStorage?.removeItem(PROJECT_ROOT_KEY);
      // Clear filter if we just removed the project being filtered to.
      const projectFilter = state.projectFilter === p ? null : state.projectFilter;
      if (state.projectFilter === p) browser.localStorage?.removeItem(PROJECT_FILTER_KEY);
      return { recentProjects, projectRoot, projectFilter };
    }),
  setArtifacts: (artifacts) => set({ artifacts }),
  setSelectedId: (selectedId) => set({ selectedId, viewedFile: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setDrift: (driftByName) => set({ driftByName }),
  patchArtifact: (next) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) => (a.id === next.id ? next : a)),
    })),
  removeArtifact: (id) =>
    set((state) => ({
      artifacts: state.artifacts.filter((a) => a.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
    })),
  setViewedFile: (viewedFile) => set({ viewedFile }),
  setTheme: (theme) => {
    browser.localStorage?.setItem(THEME_KEY, theme);
    set({ theme, resolvedTheme: resolveTheme(theme) });
  },
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),

  setCloudOpen: (b) => {
    const panel: BottomPanel = b ? "cloud" : null;
    browser.localStorage?.setItem(CLOUD_OPEN_KEY, b ? "1" : "0");
    browser.localStorage?.setItem(BOTTOM_PANEL_KEY, panel ?? "null");
    set({ cloudOpen: b, bottomPanel: panel });
  },
  toggleCloudOpen: () =>
    set((state) => {
      const next = state.bottomPanel === "cloud" ? null : "cloud";
      browser.localStorage?.setItem(CLOUD_OPEN_KEY, next === "cloud" ? "1" : "0");
      browser.localStorage?.setItem(BOTTOM_PANEL_KEY, next ?? "null");
      return { cloudOpen: next === "cloud", bottomPanel: next };
    }),
  setBottomPanel: (p) => {
    browser.localStorage?.setItem(BOTTOM_PANEL_KEY, p ?? "null");
    browser.localStorage?.setItem(CLOUD_OPEN_KEY, p === "cloud" ? "1" : "0");
    set({ bottomPanel: p, cloudOpen: p === "cloud" });
  },
  setRemoteFilter: (remoteFilter) => {
    browser.localStorage?.setItem(REMOTE_FILTER_KEY, remoteFilter);
    set({ remoteFilter, remoteSelectedId: null });
  },
  setRemoteQuery: (remoteQuery) => set({ remoteQuery }),
  setRemoteSort: (remoteSort) => set({ remoteSort }),
  setRemoteArtifacts: (remoteArtifacts) => {
    // Dedupe by id. Upstream paths (account+search merge, paged appends) can
    // overlap when the same skill surfaces from two queries — keep the first
    // occurrence so React keys stay unique.
    const seen = new Set<string>();
    const deduped: typeof remoteArtifacts = [];
    for (const a of remoteArtifacts) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      deduped.push(a);
    }
    set({ remoteArtifacts: deduped });
  },
  setRemoteSelectedId: (remoteSelectedId) => set({ remoteSelectedId, remoteViewedFile: null }),
  setRemoteLoading: (remoteLoading) => set({ remoteLoading }),
  setRemoteError: (remoteError) => set({ remoteError }),
  cacheRemoteBody: (cacheKey, body, attachments, pathToHash) =>
    set((state) => {
      const id = cacheKey.split("@")[0];
      return {
        remoteBodyCache: { ...state.remoteBodyCache, [cacheKey]: body },
        remoteAttachmentsCache: { ...state.remoteAttachmentsCache, [cacheKey]: attachments },
        remotePathToHash: { ...state.remotePathToHash, [cacheKey]: pathToHash },
        // Mirror onto the in-memory artifact so the file tree renders even
        // before its useMemo recomputes.
        remoteArtifacts: state.remoteArtifacts.map((a) =>
          a.id === id ? { ...a, body, raw: body, attachments } : a,
        ),
      };
    }),
  setRemoteSelectedVersion: (artifactId, version) =>
    set((state) => ({
      remoteSelectedVersion: { ...state.remoteSelectedVersion, [artifactId]: version },
      // Clear any file-detail view when version changes — paths/hashes differ.
      remoteViewedFile: state.remoteSelectedId === artifactId ? null : state.remoteViewedFile,
    })),
  cacheRemoteVersions: (artifactId, versions) =>
    set((state) => ({
      remoteVersionsCache: { ...state.remoteVersionsCache, [artifactId]: versions },
    })),
  markRemoteFailed: (cacheKey, message) =>
    set((state) => ({
      remoteFailedKeys: { ...state.remoteFailedKeys, [cacheKey]: message },
    })),
  cacheRemoteScan: (cacheKey, report) =>
    set((state) => ({
      remoteScanCache: { ...state.remoteScanCache, [cacheKey]: report },
    })),
  patchRemoteArtifactFrontmatter: (id, patch) =>
    set((state) => ({
      remoteArtifacts: state.remoteArtifacts.map((a) =>
        a.id === id ? { ...a, frontmatter: { ...a.frontmatter, ...patch } } : a,
      ),
    })),
  appendRemoteArtifacts: (more) =>
    set((state) => {
      const existingIds = new Set(state.remoteArtifacts.map((a) => a.id));
      const additions = more.filter((a) => !existingIds.has(a.id));
      return { remoteArtifacts: [...state.remoteArtifacts, ...additions] };
    }),
  setRemoteHasMore: (remoteHasMore) => set({ remoteHasMore }),
  setRemoteNextCursor: (remoteNextCursor) => set({ remoteNextCursor }),
  setRemoteLoadingMore: (remoteLoadingMore) => set({ remoteLoadingMore }),
  setRemoteViewedFile: (remoteViewedFile) => set({ remoteViewedFile }),
  markRemoteInstalled: (id) =>
    set((state) =>
      state.installedRemoteIds.includes(id)
        ? state
        : { installedRemoteIds: [...state.installedRemoteIds, id] },
    ),

  setView: (view) => {
    browser.localStorage?.setItem(VIEW_KEY, view);
    set({ view });
  },
  setConfigKind: (configKind) => {
    browser.localStorage?.setItem(CONFIG_KIND_KEY, configKind);
    set({ configKind });
  },
  setProjectSettingsTier: (projectSettingsTier) => {
    browser.localStorage?.setItem(PROJECT_SETTINGS_TIER_KEY, projectSettingsTier);
    set({ projectSettingsTier });
  },

  setShowSettings: (showSettings) => set({ showSettings }),
  setSettingsScrollTarget: (settingsScrollTarget) => set({ settingsScrollTarget }),
  setDefaultTool: (defaultTool) => {
    browser.localStorage?.setItem(DEFAULT_TOOL_KEY, defaultTool);
    set({ defaultTool });
  },
  setDefaultScope: (defaultScope) => {
    browser.localStorage?.setItem(DEFAULT_SCOPE_KEY, defaultScope);
    set({ defaultScope });
  },

  setLayout: (next) =>
    set((state) => {
      const merged = clampLayout({ ...state.layout, ...next });
      browser.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(merged));
      return { layout: merged };
    }),
  resetLayout: () => {
    browser.localStorage?.removeItem(LAYOUT_KEY);
    set({ layout: { ...DEFAULT_LAYOUT } });
  },

  setBackupDestination: (backupDestination) => {
    if (backupDestination) browser.localStorage?.setItem(BACKUP_DEST_KEY, backupDestination);
    else browser.localStorage?.removeItem(BACKUP_DEST_KEY);
    set({ backupDestination });
  },
  setBackupResult: (backupLastRun, backupStats) => {
    browser.localStorage?.setItem(BACKUP_LAST_RUN_KEY, String(backupLastRun));
    browser.localStorage?.setItem(BACKUP_STATS_KEY, JSON.stringify(backupStats));
    set({ backupLastRun, backupStats });
  },
  setBackupBusy: (backupBusy) => set({ backupBusy }),
  setBackupProgress: (backupProgress) => set({ backupProgress }),
  setBackupTools: (backupTools) =>
    set((state) => {
      browser.localStorage?.setItem(BACKUP_TOOLS_KEY, JSON.stringify(backupTools));
      // Seed default data-type ids for any newly enabled tool.
      const next = { ...state.backupDataTypes };
      for (const t of backupTools) {
        if (!(t in next)) next[t] = defaultDataTypeIdsFor(t);
      }
      browser.localStorage?.setItem(BACKUP_DATA_TYPES_KEY, JSON.stringify(next));
      return { backupTools, backupDataTypes: next };
    }),
  setBackupDataTypes: (tool, ids) =>
    set((state) => {
      const cleaned = normalizeDataTypeIds(tool, ids);
      const next = { ...state.backupDataTypes, [tool]: cleaned };
      browser.localStorage?.setItem(BACKUP_DATA_TYPES_KEY, JSON.stringify(next));
      return { backupDataTypes: next };
    }),
  setBackupSchedule: (backupSchedule) => {
    browser.localStorage?.setItem(BACKUP_SCHEDULE_KEY, JSON.stringify(backupSchedule));
    set({ backupSchedule });
  },

  setEditDirty: (editDirty) => set({ editDirty }),
  openHistoryPanel: (absPath) => set({ historyPanelPath: absPath, diffEntry: null }),
  closeHistoryPanel: () => set({ historyPanelPath: null, diffEntry: null }),
  openDiffEntry: (diffEntry) => set({ diffEntry }),
  closeDiffEntry: () => set({ diffEntry: null }),

  setAutoUpdate: (autoUpdate) => {
    browser.localStorage?.setItem(AUTO_UPDATE_KEY, autoUpdate ? "1" : "0");
    set({ autoUpdate });
  },
  setAvailableUpdate: (availableUpdate) => set({ availableUpdate }),
  setUpdateProgress: (updateProgress) => set({ updateProgress }),
  setUpdateError: (updateError) => set({ updateError }),
  setUpdateReadyToInstall: (updateReadyToInstall) => set({ updateReadyToInstall }),
  setDismissedUpdateVersion: (v) => {
    if (v) browser.localStorage?.setItem(DISMISSED_UPDATE_KEY, v);
    else browser.localStorage?.removeItem(DISMISSED_UPDATE_KEY);
    set({ dismissedUpdateVersion: v });
  },
  setShowUpdateDialog: (showUpdateDialog) => set({ showUpdateDialog }),
}));

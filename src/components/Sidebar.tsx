import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactType, Scope, Tool } from "../lib/artifacts/types";
import { ALL_AGENTS, displayNameOf } from "../lib/agents/registry";
import { dataTypesFor } from "../lib/backup/dataTypes";
import { useApp } from "../lib/store";
import { ArchiveIcon, GearIcon, GlobeIcon, ShieldIcon } from "./icons";
import { MASTER_TOOL_SENTINEL } from "./InventoryList";

// Data-type ids already represented by the main TYPES row (skill/agent/
// command via the artifact pipeline) — surfacing them as a second pill
// would just duplicate the user's view.
const ARTIFACT_TYPE_DUPS: ReadonlySet<string> = new Set([
  "skills",
  "agents",
  "commands",
  "prompts",
  "agents-md",
]);

// camelCase the data-type id for i18n key lookup. Mirrors CategoryBrowser.
function categoryI18nKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Sourced from the registry so adding an agent in src/lib/agents/registry.ts
// (mirroring vercel-labs/skills) automatically shows up here. Sorted by
// display name for the dropdown's UX.
const TOOLS: { id: Tool; label: string }[] = ALL_AGENTS
  .map((id) => ({ id, label: displayNameOf(id) }))
  .sort((a, b) => a.label.localeCompare(b.label));

// Lockfile scope used to live here — it loaded the same artifacts as
// `project` but also surfaced drift badges from skills-lock.json. Hidden from
// the picker because the duplication confused users; drift detection still
// runs internally if the project has a lockfile.
const SCOPES: Scope[] = ["all", "global", "project"];

const TYPES: ArtifactType[] = ["all", "skill", "agent", "command"];

// Master files are grouped by StateCategory, not by artifact type. When
// Master is the active scope, the TYPE row swaps to these pills so the
// user can narrow the master view to a single group (memory, MCP, …) or
// see everything ("all"). Kept in sync with StateCategory in
// inventory/types.ts, minus the skills/agents/commands variants which the
// artifact pipeline owns.
const MASTER_CATEGORIES: ReadonlyArray<"all" | "memory" | "mcp" | "hooks" | "permissions" | "keybindings" | "transcripts"> = [
  "all", "memory", "mcp", "hooks", "permissions", "keybindings", "transcripts",
];

// Configs only apply to global / project — there's no "all" file and no
// lockfile to drift against, so we slice the artifact-scopes down here.
const CONFIG_SCOPES: Scope[] = ["global", "project"];

interface SidebarProps {
  onToggleCloud?: () => void;
  onToggleBackup?: () => void;
  onOpenSettings?: () => void;
}

export function Sidebar({ onToggleCloud, onToggleBackup, onOpenSettings }: SidebarProps = {}) {
  const { t } = useTranslation();
  const {
    tool, scope, type, category, backupTools, backupDataTypes,
    recentTools, recentProjects, projectFilter, bottomPanel,
    view, workbenchCategory,
    setTool, setScope, setType, setCategory, setProjectRoot, setProjectFilter,
    setView, setWorkbenchCategory,
    setSettingsScrollTarget,
  } = useApp();
  // Eligible categories for the current tool: enabled in backup settings AND
  // not already covered by the TYPES row. When no tool is enabled for backup
  // at all (toolBackupOn === false), we still show the row only if a category
  // is somehow active — protects against orphaned localStorage state.
  const toolBackupOn = backupTools.includes(tool);
  const eligibleCategories = useMemo(() => {
    if (!toolBackupOn) return [];
    const enabled = new Set(backupDataTypes[tool] ?? []);
    return dataTypesFor(tool).filter(
      (dt) => enabled.has(dt.id) && !ARTIFACT_TYPE_DUPS.has(dt.id),
    );
  }, [tool, toolBackupOn, backupDataTypes]);
  const isConfigs = view === "configs";
  const isWorkbench = view === "workbench";
  const workbenchInventory = useApp((s) => s.workbenchInventory);
  const masterItems = useApp((s) => s.masterItems);

  // Categories with at least one item under the current tool/scope/project
  // filters. Mirrors InventoryList's filter pipeline minus the
  // workbenchCategory step (so the user's current category pick doesn't
  // collapse the row down to itself). The TYPE row in Master view only
  // renders pills for categories in this set, plus the "all" pill.
  const masterCategoriesWithItems = useMemo<ReadonlySet<string>>(() => {
    if (!isWorkbench) return new Set();
    const live = workbenchInventory?.items ?? [];
    const liveIds = new Set(live.map((it) => it.id));
    const masterOnly = masterItems.filter((it) => !liveIds.has(it.id));
    const merged = [...live, ...masterOnly];
    const out = new Set<string>();
    for (const it of merged) {
      if (it.tool !== MASTER_TOOL_SENTINEL && it.tool !== tool) continue;
      if (scope === "global" && it.scope !== "global") continue;
      if (scope === "project") {
        if (it.scope !== "project") continue;
        if (projectFilter && it.projectPath !== projectFilter) continue;
      }
      if (scope !== "global" && scope !== "project" && projectFilter) {
        if (it.scope === "project" && it.projectPath !== projectFilter) continue;
      }
      out.add(it.category);
    }
    return out;
  }, [isWorkbench, workbenchInventory, masterItems, tool, scope, projectFilter]);

  // If the active master category just went empty (e.g. the user switched
  // to a project that has no Hooks), drop the filter so the inventory pane
  // doesn't render as blank with no obvious reset path.
  useEffect(() => {
    if (
      isWorkbench &&
      workbenchCategory &&
      !masterCategoriesWithItems.has(workbenchCategory)
    ) {
      setWorkbenchCategory(null);
    }
  }, [isWorkbench, workbenchCategory, masterCategoriesWithItems, setWorkbenchCategory]);
  // Configs doesn't have an "all" scope; coerce silently when switching in
  // so the sub-views render against a real file. Workbench (Master) treats
  // scope as a higher-level selector — it's the master view itself, so it
  // accepts every underlying scope including "all" plus an optional project
  // filter for narrowing master items down to a single project.
  const effectiveScope: Scope =
    isConfigs && scope === "all" ? "global" : scope;

  function manageProjects() {
    setSettingsScrollTarget("settings-projects");
    onOpenSettings?.();
  }
  const cloudActive = bottomPanel === "cloud";
  const backupActive = bottomPanel === "backup";
  const toolLabel = (id: Tool) => TOOLS.find((tt) => tt.id === id)?.label ?? id;

  async function pickProject() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setProjectRoot(picked);
  }

  function projectName(path: string): string {
    const segments = path.replace(/\/+$/, "").split(/[\\/]/);
    return segments[segments.length - 1] || path;
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <ShieldIcon size={22} />
        <div className="brand-title">AI SkillSafe</div>
        {onToggleCloud && (
          <button
            className={`theme-toggle icon-btn ${cloudActive ? "active" : ""}`}
            aria-label={t("sidebar.cloudPanelAria")}
            aria-pressed={cloudActive}
            title={cloudActive ? t("sidebar.cloudPanelHide") : t("sidebar.cloudPanelShow")}
            onClick={onToggleCloud}
          >
            <GlobeIcon size={16} />
          </button>
        )}
        {onToggleBackup && (
          <button
            className={`theme-toggle icon-btn ${backupActive ? "active" : ""}`}
            aria-label={t("sidebar.backupPanelAria")}
            aria-pressed={backupActive}
            title={backupActive ? t("sidebar.backupPanelHide") : t("sidebar.backupPanelShow")}
            onClick={onToggleBackup}
          >
            <ArchiveIcon size={16} />
          </button>
        )}
        {onOpenSettings && (
          <button
            className="theme-toggle icon-btn"
            aria-label={t("sidebar.preferencesAria")}
            title={t("sidebar.preferencesTitle")}
            onClick={onOpenSettings}
          >
            <GearIcon size={16} />
          </button>
        )}
      </div>

      {!isConfigs && (
        <>
          <div className="section-label">{t("sidebar.tool")}</div>
          <select
            className="tool-select"
            value={tool}
            onChange={(e) => setTool(e.target.value as Tool)}
          >
            {TOOLS.map((tt) => (
              <option key={tt.id} value={tt.id}>{tt.label}</option>
            ))}
          </select>
          {recentTools.length > 0 && (
            <>
              <div className="section-label" id="sidebar-recent-label">{t("sidebar.recent")}</div>
              <div className="pill-row" role="tablist" aria-labelledby="sidebar-recent-label">
                {recentTools.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tool === id}
                    className={`pill ${tool === id ? "active" : ""}`}
                    onClick={() => setTool(id)}
                  >
                    {toolLabel(id)}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div className="section-label" id="sidebar-scope-label">{t("sidebar.scope")}</div>
      <div className="pill-row" role="tablist" aria-labelledby="sidebar-scope-label">
        {(isConfigs ? CONFIG_SCOPES : SCOPES).map((s) => {
          const active = !isConfigs && !isWorkbench && effectiveScope === s;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={active}
              className={`pill ${active ? "active" : ""}`}
              onClick={() => {
                if (s === "project" && recentProjects.length === 0) pickProject();
                setView("artifacts");
                setScope(s);
              }}
            >
              {t(`scopes.${s}`)}
            </button>
          );
        })}
        <button
          type="button"
          role="tab"
          aria-selected={isConfigs || isWorkbench}
          className={`pill ${isConfigs || isWorkbench ? "active" : ""}`}
          onClick={() => setView("workbench")}
          title={t("sidebar.masterTooltip")}
        >
          {t("sidebar.master")}
        </button>
      </div>

      {(effectiveScope === "project" || isWorkbench) && recentProjects.length === 0 && (
        <div className="projects-summary">
          <button className="link-btn" onClick={pickProject}>{t("sidebar.addProjectFirst")}</button>
        </div>
      )}
      {(effectiveScope === "project" || isWorkbench) && recentProjects.length > 0 && (
        <>
          <div className="section-label">{t("sidebar.filterByProject")}</div>
          <select
            className="tool-select"
            value={projectFilter ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__add__") { pickProject(); return; }
              setProjectFilter(v === "" ? null : v);
            }}
          >
            <option value="">{t("sidebar.allProjects", { count: recentProjects.length })}</option>
            {recentProjects.map((p) => (
              <option key={p} value={p}>{projectName(p)}</option>
            ))}
            <option value="__add__">{t("sidebar.addProject")}</option>
          </select>
          {recentProjects.length > 1 && (
            <div className="pill-row" role="tablist" aria-label={t("sidebar.filterByProjectAria")}>
              <button
                type="button"
                role="tab"
                aria-selected={projectFilter === null}
                className={`pill ${projectFilter === null ? "active" : ""}`}
                onClick={() => setProjectFilter(null)}
                title={t("sidebar.allProjectsTitle")}
              >
                {t("common.all")}
              </button>
              {recentProjects.slice(0, 3).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={projectFilter === p}
                  className={`pill ${projectFilter === p ? "active" : ""}`}
                  onClick={() => setProjectFilter(p)}
                  title={p}
                >
                  {projectName(p)}
                </button>
              ))}
            </div>
          )}
          <button className="link-btn" onClick={manageProjects} style={{ alignSelf: "flex-start", marginTop: 6, marginLeft: 6 }}>
            {t("sidebar.manageProjects")}
          </button>
        </>
      )}
      {scope === "all" && !isWorkbench && recentProjects.length > 0 && (
        <div className="projects-summary">
          <div className="section-label">{t("sidebar.projects")}</div>
          <div className="projects-summary-text">
            {t("sidebar.projectsLoaded", { count: recentProjects.length })}
          </div>
          <button className="link-btn" onClick={manageProjects}>{t("sidebar.manageProjects")}</button>
        </div>
      )}

      <div className="section-label" id="sidebar-type-label">{t("sidebar.type")}</div>
      <div className="pill-row" role="tablist" aria-labelledby="sidebar-type-label">
        {isWorkbench
          ? MASTER_CATEGORIES
              // "all" always renders; other pills only render when there's
              // at least one matching master file. Keeps the row from
              // listing groups the user has nothing in.
              .filter((mc) => mc === "all" || masterCategoriesWithItems.has(mc))
              .map((mc) => {
                // "all" pill = no filter (workbenchCategory === null).
                const active =
                  mc === "all" ? workbenchCategory === null : workbenchCategory === mc;
                return (
                  <button
                    key={mc}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`pill ${active ? "active" : ""}`}
                    onClick={() => {
                      // Stay in Master view; just narrow the inventory list.
                      setWorkbenchCategory(mc === "all" ? null : mc);
                    }}
                  >
                    {t(`masterCategories.${mc}`)}
                  </button>
                );
              })
          : TYPES.map((tt) => {
              const active = !isConfigs && category === null && type === tt;
              return (
                <button
                  key={tt}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`pill ${active ? "active" : ""}`}
                  onClick={() => {
                    setView("artifacts");
                    setType(tt);
                  }}
                >
                  {t(`types.${tt}`)}
                </button>
              );
            })}
        {!isConfigs && !isWorkbench && eligibleCategories.map((dt) => {
          const active = category === dt.id;
          const camel = categoryI18nKey(dt.id);
          const label = t(`categories.${camel}`, { defaultValue: dt.label });
          const tooltip = dt.description
            ? t(`categories.${camel}Desc`, { defaultValue: dt.description })
            : label;
          return (
            <button
              key={`cat-${dt.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              className={`pill ${active ? "active" : ""}`}
              title={tooltip}
              onClick={() => {
                setView("artifacts");
                setCategory(dt.id);
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

    </aside>
  );
}

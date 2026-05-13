import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import type { ArtifactType, Scope, Tool } from "../lib/artifacts/types";
import { ALL_AGENTS, displayNameOf } from "../lib/agents/registry";
import { useApp } from "../lib/store";
import { ArchiveIcon, GearIcon, GlobeIcon, ShieldIcon } from "./icons";

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
    tool, scope, type, recentTools, recentProjects, projectFilter, bottomPanel,
    view,
    setTool, setScope, setType, setProjectRoot, setProjectFilter,
    setView,
    setSettingsScrollTarget,
  } = useApp();
  const isConfigs = view === "configs";
  const isWorkbench = view === "workbench";
  // Configs/Workbench don't have an "all" scope; coerce silently when
  // switching in so the sub-views render against a real file.
  const effectiveScope: Scope =
    (isConfigs || isWorkbench) && scope === "all" ? "global" : scope;

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
        {(isConfigs ? CONFIG_SCOPES : SCOPES).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={effectiveScope === s}
            className={`pill ${effectiveScope === s ? "active" : ""}`}
            onClick={() => {
              if (s === "project" && recentProjects.length === 0) pickProject();
              setScope(s);
            }}
          >
            {t(`scopes.${s}`)}
          </button>
        ))}
      </div>

      {effectiveScope === "project" && recentProjects.length === 0 && (
        <div className="projects-summary">
          <button className="link-btn" onClick={pickProject}>{t("sidebar.addProjectFirst")}</button>
        </div>
      )}
      {effectiveScope === "project" && recentProjects.length > 0 && (
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
      {scope === "all" && recentProjects.length > 0 && (
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
        {TYPES.map((tt) => (
          <button
            key={tt}
            type="button"
            role="tab"
            aria-selected={!isConfigs && !isWorkbench && type === tt}
            className={`pill ${!isConfigs && !isWorkbench && type === tt ? "active" : ""}`}
            onClick={() => {
              setView("artifacts");
              setType(tt);
            }}
          >
            {t(`types.${tt}`)}
          </button>
        ))}
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

    </aside>
  );
}

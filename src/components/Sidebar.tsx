import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
];

const TYPES: { id: ArtifactType; label: string }[] = [
  { id: "all", label: "All" },
  { id: "skill", label: "Skills" },
  { id: "agent", label: "Agents" },
  { id: "command", label: "Commands" },
];

// Configs only apply to global / project — there's no "all" file and no
// lockfile to drift against, so we slice the artifact-scopes down here.
const CONFIG_SCOPES: { id: Scope; label: string }[] = [
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
];

interface SidebarProps {
  onToggleCloud?: () => void;
  onToggleBackup?: () => void;
  onOpenSettings?: () => void;
}

export function Sidebar({ onToggleCloud, onToggleBackup, onOpenSettings }: SidebarProps = {}) {
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
  const toolLabel = (id: Tool) => TOOLS.find((t) => t.id === id)?.label ?? id;

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
            aria-label="skillsafe.ai cloud panel"
            aria-pressed={cloudActive}
            title={cloudActive ? "Hide cloud panel" : "Show cloud panel"}
            onClick={onToggleCloud}
          >
            <GlobeIcon size={16} />
          </button>
        )}
        {onToggleBackup && (
          <button
            className={`theme-toggle icon-btn ${backupActive ? "active" : ""}`}
            aria-label="Local backup panel"
            aria-pressed={backupActive}
            title={backupActive ? "Hide local backup panel" : "Local Backup"}
            onClick={onToggleBackup}
          >
            <ArchiveIcon size={16} />
          </button>
        )}
        {onOpenSettings && (
          <button
            className="theme-toggle icon-btn"
            aria-label="Open preferences"
            title="Preferences"
            onClick={onOpenSettings}
          >
            <GearIcon size={16} />
          </button>
        )}
      </div>

      {!isConfigs && (
        <>
          <div className="section-label">Tool</div>
          <select
            className="tool-select"
            value={tool}
            onChange={(e) => setTool(e.target.value as Tool)}
          >
            {TOOLS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          {recentTools.length > 0 && (
            <>
              <div className="section-label" id="sidebar-recent-label">Recent</div>
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

      <div className="section-label" id="sidebar-scope-label">Scope</div>
      <div className="pill-row" role="tablist" aria-labelledby="sidebar-scope-label">
        {(isConfigs ? CONFIG_SCOPES : SCOPES).map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={effectiveScope === s.id}
            className={`pill ${effectiveScope === s.id ? "active" : ""}`}
            onClick={() => {
              if (s.id === "project" && recentProjects.length === 0) pickProject();
              setScope(s.id);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {effectiveScope === "project" && recentProjects.length === 0 && (
        <div className="projects-summary">
          <button className="link-btn" onClick={pickProject}>+ Add a project…</button>
        </div>
      )}
      {effectiveScope === "project" && recentProjects.length > 0 && (
        <>
          <div className="section-label">Filter by project</div>
          <select
            className="tool-select"
            value={projectFilter ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__add__") { pickProject(); return; }
              setProjectFilter(v === "" ? null : v);
            }}
          >
            <option value="">All projects ({recentProjects.length})</option>
            {recentProjects.map((p) => (
              <option key={p} value={p}>{projectName(p)}</option>
            ))}
            <option value="__add__">+ Add project…</option>
          </select>
          {recentProjects.length > 1 && (
            <div className="pill-row" role="tablist" aria-label="Filter by project">
              <button
                type="button"
                role="tab"
                aria-selected={projectFilter === null}
                className={`pill ${projectFilter === null ? "active" : ""}`}
                onClick={() => setProjectFilter(null)}
                title="Show artifacts from every project"
              >
                All
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
            Manage projects…
          </button>
        </>
      )}
      {scope === "all" && recentProjects.length > 0 && (
        <div className="projects-summary">
          <div className="section-label">Projects</div>
          <div className="projects-summary-text">
            {recentProjects.length} {recentProjects.length === 1 ? "project" : "projects"} loaded
          </div>
          <button className="link-btn" onClick={manageProjects}>Manage projects…</button>
        </div>
      )}

      <div className="section-label" id="sidebar-type-label">Type</div>
      <div className="pill-row" role="tablist" aria-labelledby="sidebar-type-label">
        {TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={!isConfigs && !isWorkbench && type === t.id}
            className={`pill ${!isConfigs && !isWorkbench && type === t.id ? "active" : ""}`}
            onClick={() => {
              setView("artifacts");
              setType(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={isConfigs || isWorkbench}
          className={`pill ${isConfigs || isWorkbench ? "active" : ""}`}
          onClick={() => setView("workbench")}
          title={
            "Files that can be saved to your master folder — CLAUDE.md / AGENTS.md memory, " +
            ".mcp.json servers, hooks, permissions, keybindings. " +
            "Add the live source to master, restore the source from master, or diff the two."
          }
        >
          Master
        </button>
      </div>

    </aside>
  );
}

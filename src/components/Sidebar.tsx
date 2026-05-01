import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ArtifactType, Scope, Tool } from "../lib/artifacts/types";
import { useApp } from "../lib/store";
import { ArchiveIcon, GearIcon, GlobeIcon, ShieldIcon } from "./icons";

const TOOLS: { id: Tool; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "openclaw", label: "OpenClaw" },
  { id: "cline", label: "Cline" },
  { id: "hermes", label: "Hermes" },
];

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

interface SidebarProps {
  onToggleCloud?: () => void;
  onToggleBackup?: () => void;
  onOpenSettings?: () => void;
}

export function Sidebar({ onToggleCloud, onToggleBackup, onOpenSettings }: SidebarProps = {}) {
  const {
    tool, scope, type, recentTools, recentProjects, projectFilter, bottomPanel,
    setTool, setScope, setType, setProjectRoot, setProjectFilter,
  } = useApp();
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
            aria-label={cloudActive ? "Hide skillsafe.ai cloud panel" : "Show skillsafe.ai cloud panel"}
            title={cloudActive ? "Hide cloud panel" : "Show cloud panel"}
            onClick={onToggleCloud}
          >
            <GlobeIcon size={16} />
          </button>
        )}
        {onToggleBackup && (
          <button
            className={`theme-toggle icon-btn ${backupActive ? "active" : ""}`}
            aria-label={backupActive ? "Hide local backup panel" : "Show local backup panel"}
            title={backupActive ? "Hide local backup panel" : "Local Backup"}
            onClick={onToggleBackup}
          >
            <ArchiveIcon size={16} />
          </button>
        )}
        {onOpenSettings && (
          <button
            className="theme-toggle icon-btn"
            aria-label="Open settings"
            title="Settings"
            onClick={onOpenSettings}
          >
            <GearIcon size={16} />
          </button>
        )}
      </div>

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
          <div className="section-label">Recent</div>
          <div className="pill-row">
            {recentTools.map((id) => (
              <div
                key={id}
                className={`pill ${tool === id ? "active" : ""}`}
                onClick={() => setTool(id)}
              >
                {toolLabel(id)}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-label">Scope</div>
      <div className="pill-row">
        {SCOPES.map((s) => (
          <div
            key={s.id}
            className={`pill ${scope === s.id ? "active" : ""}`}
            onClick={() => {
              if (s.id === "project" && recentProjects.length === 0) pickProject();
              setScope(s.id);
            }}
          >
            {s.label}
          </div>
        ))}
      </div>

      <div className="section-label">Type</div>
      <div className="pill-row">
        {TYPES.map((t) => (
          <div
            key={t.id}
            className={`pill ${type === t.id ? "active" : ""}`}
            onClick={() => setType(t.id)}
          >
            {t.label}
          </div>
        ))}
      </div>

      {scope === "project" && recentProjects.length === 0 && (
        <div className="projects-summary">
          <button className="link-btn" onClick={pickProject}>+ Add a project…</button>
        </div>
      )}
      {scope === "project" && recentProjects.length > 0 && (
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
            <div className="pill-row">
              <div
                className={`pill ${projectFilter === null ? "active" : ""}`}
                onClick={() => setProjectFilter(null)}
                title="Show artifacts from every project"
              >
                All
              </div>
              {recentProjects.slice(0, 3).map((p) => (
                <div
                  key={p}
                  className={`pill ${projectFilter === p ? "active" : ""}`}
                  onClick={() => setProjectFilter(p)}
                  title={p}
                >
                  {projectName(p)}
                </div>
              ))}
            </div>
          )}
          <button className="link-btn" onClick={onOpenSettings} style={{ alignSelf: "flex-start", marginTop: 6, marginLeft: 6 }}>
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
          <button className="link-btn" onClick={onOpenSettings}>Manage projects…</button>
        </div>
      )}

    </aside>
  );
}

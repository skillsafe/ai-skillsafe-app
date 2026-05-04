import { useEffect, useMemo, useState } from "react";
import type { Tool } from "../lib/artifacts/types";
import { ALL_AGENTS, displayNameOf, getAgentConfig } from "../lib/agents/registry";
import { tauriPaths } from "../lib/tauriAdapters";

export interface InstallScopeChoice {
  scope: "global" | "project";
  projectRoot?: string;
  tool: Tool;
}

interface Props {
  artifactName: string;
  // Initial agent — defaults to the sidebar selection. The user can change
  // it inside the dialog, which determines where the skill lands (e.g.
  // cursor → ~/.cursor/skills, codex → ~/.codex/skills).
  tool: Tool;
  recentProjects: ReadonlyArray<string>;
  defaultScope: "global" | "project";
  defaultProjectRoot?: string | null;
  busy?: boolean;
  onConfirm: (choice: InstallScopeChoice) => void;
  onCancel: () => void;
}

export function InstallScopeDialog({
  artifactName,
  tool: initialTool,
  recentProjects,
  defaultScope,
  defaultProjectRoot,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const projects = useMemo(
    () => recentProjects.filter(Boolean),
    [recentProjects],
  );
  // If the user has no recent projects, project install isn't reachable.
  const initialScope: "global" | "project" =
    defaultScope === "project" && projects.length > 0 ? "project" : "global";
  const [scope, setScope] = useState<"global" | "project">(initialScope);
  const [projectRoot, setProjectRoot] = useState<string>(() => {
    if (defaultProjectRoot && projects.includes(defaultProjectRoot)) return defaultProjectRoot;
    return projects[0] ?? "";
  });
  const [tool, setTool] = useState<Tool>(initialTool);

  // Resolve the actual global skill dir for the selected tool, so the hint
  // shows e.g. "~/.cursor/skills/<name>" for Cursor or "~/.codex/skills/<name>"
  // for Codex — not a hardcoded ~/.claude/skills/.
  const cfg = getAgentConfig(tool);
  const projectSkillsDir = cfg?.skillsDir ?? "";
  const [globalDirHint, setGlobalDirHint] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!cfg) {
      setGlobalDirHint(null);
      return;
    }
    cfg
      .globalSkillsDir(tauriPaths)
      .then((dir) => {
        if (!cancelled) setGlobalDirHint(homeify(dir));
      })
      .catch(() => {
        if (!cancelled) setGlobalDirHint(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  // Claude is the one outlier: project installs go under .agents/skills, not
  // .claude/skills, mirroring App.tsx::targetDir's behavior so installs line
  // up with what `npx skills add claude-code` would have written.
  const projectDirHint = tool === "claude" ? ".agents/skills" : projectSkillsDir;

  const canConfirm =
    !busy && (scope === "global" || (scope === "project" && projectRoot.length > 0));

  function handleConfirm() {
    if (!canConfirm) return;
    if (scope === "global") {
      onConfirm({ scope: "global", tool });
    } else {
      onConfirm({ scope: "project", projectRoot, tool });
    }
  }

  return (
    <div className="dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Install {artifactName}</h3>

        <div className="fm-field">
          <label className="fm-label" htmlFor="install-scope-tool-select">target tool</label>
          <select
            id="install-scope-tool-select"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            disabled={busy}
          >
            {ALL_AGENTS.map((a) => (
              <option key={a} value={a}>{displayNameOf(a)}</option>
            ))}
          </select>
        </div>

        <div className="fm-field">
          <label className="fm-label">target</label>
          <div className="install-scope-options">
            <label className="install-scope-option">
              <input
                type="radio"
                name="install-scope"
                value="global"
                checked={scope === "global"}
                onChange={() => setScope("global")}
                disabled={busy}
              />
              <span>
                <strong>Global</strong>
                <span className="install-scope-hint">
                  {globalDirHint
                    ? `${globalDirHint}/${artifactName}`
                    : `(resolving ${displayNameOf(tool)} skills dir…)`}
                </span>
              </span>
            </label>

            <label
              className={`install-scope-option ${projects.length === 0 ? "disabled" : ""}`}
            >
              <input
                type="radio"
                name="install-scope"
                value="project"
                checked={scope === "project"}
                onChange={() => setScope("project")}
                disabled={busy || projects.length === 0}
              />
              <span>
                <strong>Project</strong>
                {projects.length === 0 ? (
                  <span className="install-scope-hint">
                    No recent projects — open a project first to enable this option.
                  </span>
                ) : (
                  <span className="install-scope-hint">
                    &lt;projectRoot&gt;/{projectDirHint}/{artifactName}
                  </span>
                )}
              </span>
            </label>
          </div>
        </div>

        {scope === "project" && projects.length > 0 && (
          <div className="fm-field">
            <label className="fm-label">project</label>
            <select
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              disabled={busy}
            >
              {projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        )}

        <div className="dialog-row">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="primary"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {busy ? "Installing…" : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Render an absolute path with the user's home dir replaced by `~` so the
// install hint reads as "~/.cursor/skills/foo" instead of the absolute
// "/Users/jane/.cursor/skills/foo".
function homeify(absPath: string): string {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)(.*)$/.exec(absPath);
  if (!m) return absPath;
  return `~${m[2]}`;
}

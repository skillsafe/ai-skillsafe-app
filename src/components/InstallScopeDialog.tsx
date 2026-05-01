import { useMemo, useState } from "react";

export interface InstallScopeChoice {
  scope: "global" | "project";
  projectRoot?: string;
}

interface Props {
  artifactName: string;
  recentProjects: ReadonlyArray<string>;
  defaultScope: "global" | "project";
  defaultProjectRoot?: string | null;
  busy?: boolean;
  onConfirm: (choice: InstallScopeChoice) => void;
  onCancel: () => void;
}

export function InstallScopeDialog({
  artifactName,
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

  const canConfirm =
    !busy && (scope === "global" || (scope === "project" && projectRoot.length > 0));

  function handleConfirm() {
    if (!canConfirm) return;
    if (scope === "global") {
      onConfirm({ scope: "global" });
    } else {
      onConfirm({ scope: "project", projectRoot });
    }
  }

  return (
    <div className="dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Install {artifactName}</h3>

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
                <span className="install-scope-hint">~/.claude/skills/{artifactName}</span>
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
                    &lt;projectRoot&gt;/.agents/skills/{artifactName}
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

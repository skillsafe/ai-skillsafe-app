import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useApp } from "../lib/store";

export function ProjectRootPicker() {
  const { projectRoot, setProjectRoot } = useApp();

  async function pickProject() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setProjectRoot(picked);
  }

  return (
    <div className="project-box">
      <div className="project-path">{projectRoot ?? "— not selected —"}</div>
      <div className="cloud-row">
        <button onClick={pickProject}>Pick folder…</button>
        {projectRoot && (
          <button onClick={() => setProjectRoot(null)}>Clear</button>
        )}
      </div>
    </div>
  );
}

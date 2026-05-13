import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";

export function ProjectRootPicker() {
  const { t } = useTranslation();
  const { projectRoot, setProjectRoot } = useApp();

  async function pickProject() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setProjectRoot(picked);
  }

  return (
    <div className="project-box">
      <div className="project-path">{projectRoot ?? t("projectPicker.notSelected")}</div>
      <div className="cloud-row">
        <button onClick={pickProject}>{t("projectPicker.pickFolder")}</button>
        {projectRoot && (
          <button onClick={() => setProjectRoot(null)}>{t("projectPicker.clear")}</button>
        )}
      </div>
    </div>
  );
}

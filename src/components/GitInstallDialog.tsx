import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import {
  installFromGit,
  parseGitSpec,
  type GitInstallResult,
} from "../lib/skillsafe/gitInstall";
import {
  gitSourcesPath,
  upsertGitSource,
} from "../lib/skillsafe/gitSources";
import type { Scope, Tool } from "../lib/artifacts/types";

interface Props {
  open: boolean;
  onClose: () => void;
  onInstalled: () => Promise<void> | void;
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function GitInstallDialog({ open, onClose, onInstalled, onToast }: Props) {
  const { t } = useTranslation();
  const { tool, scope, projectRoot, recentProjects } = useApp();
  const [spec, setSpec] = useState("");
  const [pinCommit, setPinCommit] = useState(false);
  const [chosenTool, setChosenTool] = useState<Tool>(tool);
  const [chosenScope, setChosenScope] = useState<Scope>(
    scope === "global" || scope === "project" ? scope : "global",
  );
  const [chosenProject, setChosenProject] = useState<string | null>(projectRoot);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const parsed = parseGitSpec(spec);

  const onInstall = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const result: GitInstallResult = await installFromGit(
        tauriFs,
        tauriPaths,
        tauriJoiner,
        {
          ...parsed,
          pin: pinCommit,
          tool: chosenTool,
          scope: chosenScope,
          projectRoot: chosenScope === "project" ? chosenProject ?? undefined : undefined,
        },
      );
      const home = await tauriPaths.homeDir();
      const sourcesPath = await gitSourcesPath(tauriJoiner, home);
      for (const bundle of result.bundles) {
        await upsertGitSource(tauriFs, tauriJoiner, sourcesPath, bundle.name, {
          owner: result.owner,
          repo: result.repo,
          ref: result.ref,
          commit: result.commit,
          pinned: pinCommit,
          subpath: parsed.subpath,
          tool: chosenTool,
          scope: chosenScope,
          projectRoot: chosenScope === "project" ? chosenProject ?? undefined : undefined,
          targetDir: bundle.targetDir,
          installedHash: bundle.skillHash,
          installedAt: Date.now(),
        });
      }
      onToast(
        "ok",
        t("gitInstall.installedToast", {
          count: result.bundles.length,
          owner: result.owner,
          repo: result.repo,
        }),
      );
      setSpec("");
      onClose();
      await onInstalled();
    } catch (err) {
      onToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog git-install-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t("gitInstall.title")}</h3>
        <p className="dialog-hint">{t("gitInstall.hint")}</p>
        <div className="form-row">
          <label htmlFor="git-spec">{t("gitInstall.specLabel")}</label>
          <input
            id="git-spec"
            autoFocus
            placeholder="anthropics/skills@main:skills/test-driven-development"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
          />
        </div>
        {parsed && (
          <div className="git-parsed">
            <code>{parsed.owner}/{parsed.repo}</code>
            {parsed.ref && <span> @ <code>{parsed.ref}</code></span>}
            {parsed.subpath && <span> · <code>{parsed.subpath}</code></span>}
          </div>
        )}
        <div className="form-row">
          <label>
            <input
              type="checkbox"
              checked={pinCommit}
              onChange={(e) => setPinCommit(e.target.checked)}
            />
            {" "}{t("gitInstall.pinCommit")}
          </label>
        </div>
        <div className="form-row">
          <label htmlFor="git-tool">{t("gitInstall.targetTool")}</label>
          <input
            id="git-tool"
            value={chosenTool}
            onChange={(e) => setChosenTool(e.target.value as Tool)}
          />
        </div>
        <div className="form-row">
          <label>{t("gitInstall.targetScope")}</label>
          <div className="pill-row">
            <button
              type="button"
              className={`pill ${chosenScope === "global" ? "active" : ""}`}
              onClick={() => setChosenScope("global")}
            >
              {t("installScope.global")}
            </button>
            <button
              type="button"
              className={`pill ${chosenScope === "project" ? "active" : ""}`}
              onClick={() => setChosenScope("project")}
              disabled={recentProjects.length === 0}
            >
              {t("installScope.project")}
            </button>
          </div>
        </div>
        {chosenScope === "project" && (
          <div className="form-row">
            <label htmlFor="git-project">{t("installScope.projectField")}</label>
            <select
              id="git-project"
              value={chosenProject ?? ""}
              onChange={(e) => setChosenProject(e.target.value || null)}
            >
              <option value="" disabled>—</option>
              {recentProjects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        )}
        <div className="dialog-row">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button
            className="primary"
            disabled={!parsed || busy || (chosenScope === "project" && !chosenProject)}
            onClick={onInstall}
          >
            {busy ? t("installScope.installing") : t("installScope.installButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

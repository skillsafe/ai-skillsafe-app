import { useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { lockfilePath } from "../lib/paths";
import { readLockfile, writeLockfile, type Lockfile } from "../lib/lockfile";
import {
  detectLockfileFormat,
  importLockfile,
  foreignToSkillsafe,
  type LockfileFormat,
  type ForeignLockfile,
} from "../lib/lockfile/formats";

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => Promise<void> | void;
  onToast: (kind: "ok" | "error", text: string) => void;
}

interface Preview {
  format: LockfileFormat;
  foreign: ForeignLockfile;
  converted: Lockfile;
  existing: Lockfile | null;
}

export function LockfileImportDialog({ open, onClose, onImported, onToast }: Props) {
  const { t } = useTranslation();
  const projectRoot = useApp((s) => s.projectRoot);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function pickFile() {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [
          { name: "Lockfile", extensions: ["json", "yaml", "yml", "lock", "toml"] },
        ],
      });
      if (typeof picked !== "string") return;
      const raw = await tauriFs.readTextFile(picked);
      const format = detectLockfileFormat(raw);
      if (format === "unknown") {
        onToast("error", t("lockfileImport.unrecognized"));
        return;
      }
      const foreign = importLockfile(raw);
      const converted = foreignToSkillsafe(foreign);
      const existing = projectRoot
        ? await readLockfile(tauriFs, await lockfilePath(tauriPaths, projectRoot)).catch(() => null)
        : null;
      setPreview({ format, foreign, converted, existing });
    } catch (err) {
      onToast("error", err instanceof Error ? err.message : String(err));
    }
  }

  async function applyImport() {
    if (!preview || !projectRoot) return;
    setBusy(true);
    try {
      const target = await lockfilePath(tauriPaths, projectRoot);
      await writeLockfile(tauriFs, tauriJoiner, target, preview.converted);
      onToast("ok", t("lockfileImport.applied", { count: Object.keys(preview.converted.skills).length }));
      setPreview(null);
      onClose();
      await onImported();
    } catch (err) {
      onToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const diff = preview ? diffSkills(preview.existing, preview.converted) : null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t("lockfileImport.title")}</h3>
        <p className="dialog-hint">{t("lockfileImport.hint")}</p>

        {!preview && (
          <div className="form-row">
            <button type="button" onClick={pickFile}>{t("lockfileImport.pickFile")}</button>
            {!projectRoot && (
              <p className="dialog-hint">{t("lockfileImport.needsProject")}</p>
            )}
          </div>
        )}

        {preview && diff && (
          <>
            <div className="form-row">
              <div>
                <strong>{t("lockfileImport.detectedAs")}</strong>{" "}
                <code>{preview.format}</code>
              </div>
              <div>
                {t("lockfileImport.skillCount", {
                  count: Object.keys(preview.converted.skills).length,
                })}
              </div>
            </div>
            <div className="form-row">
              <div className="lockfile-diff">
                {diff.added.length > 0 && (
                  <div>
                    <strong>+ {t("lockfileImport.added")}:</strong> {diff.added.join(", ")}
                  </div>
                )}
                {diff.removed.length > 0 && (
                  <div>
                    <strong>- {t("lockfileImport.removed")}:</strong> {diff.removed.join(", ")}
                  </div>
                )}
                {diff.changed.length > 0 && (
                  <div>
                    <strong>~ {t("lockfileImport.changed")}:</strong> {diff.changed.join(", ")}
                  </div>
                )}
                {diff.added.length + diff.removed.length + diff.changed.length === 0 && (
                  <div>{t("lockfileImport.noChanges")}</div>
                )}
              </div>
            </div>
            <div className="form-row dialog-actions">
              <button type="button" onClick={() => setPreview(null)} disabled={busy}>
                {t("common.back")}
              </button>
              <button type="button" onClick={applyImport} disabled={busy}>
                {busy ? t("lockfileImport.applying") : t("lockfileImport.apply")}
              </button>
            </div>
          </>
        )}

        <div className="form-row dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

function diffSkills(existing: Lockfile | null, next: Lockfile): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const oldSkills = existing?.skills ?? {};
  const newSkills = next.skills;
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const name of Object.keys(newSkills)) {
    if (!(name in oldSkills)) added.push(name);
    else if (oldSkills[name].computedHash !== newSkills[name].computedHash) changed.push(name);
  }
  for (const name of Object.keys(oldSkills)) {
    if (!(name in newSkills)) removed.push(name);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

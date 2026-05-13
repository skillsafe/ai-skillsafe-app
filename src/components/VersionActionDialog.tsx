import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listSkillVersions, SkillSafeError } from "../lib/skillsafe/client";

export type VersionAction = "set-current" | "yank";

interface Props {
  apiKey: string;
  ns: string;
  name: string;
  // The version to pre-select (typically the artifact's latest_version).
  defaultVersion?: string;
  // Optional version list. If not supplied, the dialog fetches once.
  versions?: ReadonlyArray<string>;
  action: VersionAction;
  busy?: boolean;
  onConfirm: (choice: { version: string; reason?: string }) => void;
  onCancel: () => void;
}

export function VersionActionDialog({
  apiKey,
  ns,
  name,
  defaultVersion,
  versions: versionsProp,
  action,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<string[] | null>(
    versionsProp ? [...versionsProp] : null,
  );
  const [version, setVersion] = useState<string>(defaultVersion ?? versionsProp?.[0] ?? "");
  const [reason, setReason] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (versionsProp) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await listSkillVersions(ns, name, apiKey);
        if (cancelled) return;
        const list = data.map((v) => v.version);
        setVersions(list);
        if (!version && list.length > 0) setVersion(list[0]);
      } catch (e) {
        if (!cancelled) setLoadError(describeError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [ns, name, apiKey, versionsProp, version]);

  const isYank = action === "yank";
  const title = isYank
    ? t("versionAction.titleYank", { ns, name })
    : t("versionAction.titleSetCurrent", { ns, name });
  const confirmLabel = isYank ? t("versionAction.confirmYank") : t("versionAction.confirmSetCurrent");
  const explanation = isYank ? t("versionAction.explainYank") : t("versionAction.explainSetCurrent");

  const canConfirm = !busy && !!version;

  return (
    <div className="dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="confirm-message">{explanation}</div>

        <div className="fm-field">
          <label className="fm-label">{t("versionAction.versionLabel")}</label>
          {versions === null && !loadError ? (
            <div className="cloud-static">{t("versionAction.loadingVersions")}</div>
          ) : loadError ? (
            <div className="empty-error">{loadError}</div>
          ) : (
            <select
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={busy}
            >
              {(versions ?? []).map((v) => (
                <option key={v} value={v}>v{v}</option>
              ))}
            </select>
          )}
        </div>

        {isYank && (
          <div className="fm-field">
            <label className="fm-label">{t("versionAction.reasonLabel")}</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder={t("versionAction.reasonPlaceholder")}
              disabled={busy}
            />
          </div>
        )}

        <div className="dialog-row">
          <button onClick={onCancel} disabled={busy}>{t("common.cancel")}</button>
          <button
            className={isYank ? "danger" : "primary"}
            onClick={() => onConfirm({ version, reason: isYank ? reason : undefined })}
            disabled={!canConfirm}
          >
            {busy ? t("common.working") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function describeError(e: unknown): string {
  if (e instanceof SkillSafeError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

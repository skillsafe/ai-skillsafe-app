import { useTranslation } from "react-i18next";
import type { ShieldVerdict } from "../lib/skillsafe/shield";
import { SafetyBadge } from "./SafetyBadge";

interface Props {
  /** The block verdict from runShield, with matchedRules + reason. */
  verdict: Extract<ShieldVerdict, { kind: "block" }>;
  /** Display name of the skill that was blocked, for the title bar. */
  skillName: string;
  onClose: () => void;
}

export function QuarantineDialog({ verdict, skillName, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="form-row">
          <SafetyBadge variant="critical" label={t("quarantine.blockedBadge")} />
          <h3 style={{ margin: 0 }}>{t("quarantine.blockedTitle", { name: skillName })}</h3>
        </div>
        <p className="dialog-hint">{t("quarantine.blockedHint")}</p>
        <div className="form-row">
          <strong>{t("quarantine.matchedRules")}</strong>
          <ul className="quarantine-rule-list">
            {verdict.matchedRules.map((rule) => (
              <li key={rule}><code>{rule}</code></li>
            ))}
          </ul>
        </div>
        <div className="form-row">
          <strong>{t("quarantine.reason")}</strong>
          <div className="quarantine-reason">{verdict.reason}</div>
        </div>
        <div className="form-row dialog-actions">
          <button type="button" onClick={onClose}>{t("quarantine.acknowledge")}</button>
        </div>
      </div>
    </div>
  );
}

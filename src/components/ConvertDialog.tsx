import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactType, MarkdownArtifact, Tool } from "../lib/artifacts/types";
import { ALL_AGENTS, displayNameOf } from "../lib/agents/registry";

interface Props {
  source: MarkdownArtifact;
  onCancel: () => void;
  onConvert: (targetTool: Tool, targetType: ArtifactType) => Promise<void>;
}

const TOOLS: Tool[] = ALL_AGENTS;
const TYPES: ArtifactType[] = ["skill", "agent", "command"];

export function ConvertDialog({ source, onCancel, onConvert }: Props) {
  const { t } = useTranslation();
  const [targetTool, setTargetTool] = useState<Tool>(source.tool === "claude" ? "cursor" : "claude");
  const [targetType, setTargetType] = useState<ArtifactType>(source.type);
  const [busy, setBusy] = useState(false);

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t("convert.title", { name: source.name })}</h3>
        <div className="fm-field">
          <label className="fm-label">{t("convert.targetTool")}</label>
          <select value={targetTool} onChange={(e) => setTargetTool(e.target.value as Tool)}>
            {TOOLS.filter((tt) => tt !== source.tool).map((tt) => (
              <option key={tt} value={tt}>{displayNameOf(tt)}</option>
            ))}
          </select>
        </div>
        <div className="fm-field">
          <label className="fm-label">{t("convert.targetType")}</label>
          <select value={targetType} onChange={(e) => setTargetType(e.target.value as ArtifactType)}>
            {TYPES.map((tt) => <option key={tt} value={tt}>{t(`types.${tt}`)}</option>)}
          </select>
        </div>
        <div className="dialog-row">
          <button onClick={onCancel}>{t("common.cancel")}</button>
          <button
            className="primary"
            onClick={async () => {
              setBusy(true);
              try {
                await onConvert(targetTool, targetType);
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            {t("convert.convertButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

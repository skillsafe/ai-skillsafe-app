import { useState } from "react";
import type { ArtifactType, MarkdownArtifact, Tool } from "../lib/artifacts/types";

interface Props {
  source: MarkdownArtifact;
  onCancel: () => void;
  onConvert: (targetTool: Tool, targetType: ArtifactType) => Promise<void>;
}

const TOOLS: Tool[] = ["claude", "codex", "cursor", "openclaw", "cline", "hermes"];
const TYPES: ArtifactType[] = ["skill", "agent", "command"];

export function ConvertDialog({ source, onCancel, onConvert }: Props) {
  const [targetTool, setTargetTool] = useState<Tool>(source.tool === "claude" ? "cursor" : "claude");
  const [targetType, setTargetType] = useState<ArtifactType>(source.type);
  const [busy, setBusy] = useState(false);

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Convert “{source.name}”</h3>
        <div className="fm-field">
          <label className="fm-label">target tool</label>
          <select value={targetTool} onChange={(e) => setTargetTool(e.target.value as Tool)}>
            {TOOLS.filter((t) => t !== source.tool).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="fm-field">
          <label className="fm-label">target type</label>
          <select value={targetType} onChange={(e) => setTargetType(e.target.value as ArtifactType)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="dialog-row">
          <button onClick={onCancel}>Cancel</button>
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
            Convert
          </button>
        </div>
      </div>
    </div>
  );
}

import { DiffEditor } from "@monaco-editor/react";
import { useApp } from "../lib/store";

interface Props {
  original: string;
  modified: string;
  language: string;
  originalLabel: string;
  modifiedLabel: string;
  onClose: () => void;
}

export function DiffView({
  original,
  modified,
  language,
  originalLabel,
  modifiedLabel,
  onClose,
}: Props) {
  const theme = useApp((s) => s.resolvedTheme);
  return (
    <div className="diff-overlay">
      <div className="diff-overlay__header">
        <div className="diff-overlay__labels">
          <span className="diff-overlay__label diff-overlay__label--original">{originalLabel}</span>
          <span className="diff-overlay__arrow">→</span>
          <span className="diff-overlay__label diff-overlay__label--modified">{modifiedLabel}</span>
        </div>
        <button className="diff-overlay__close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="diff-overlay__body">
        <DiffEditor
          height="100%"
          language={language}
          theme={theme === "light" ? "vs" : "vs-dark"}
          original={original}
          modified={modified}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            wordWrap: "on",
            fontSize: 13,
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

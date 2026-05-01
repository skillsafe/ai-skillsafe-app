import Monaco from "@monaco-editor/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import type { MarkdownArtifact } from "../lib/artifacts/types";
import { renderMarkdown } from "../lib/markdown";
import { useApp } from "../lib/store";

interface Props {
  artifact: MarkdownArtifact | null;
}

export function Editor({ artifact }: Props) {
  const theme = useApp((s) => s.resolvedTheme);
  const viewedFile = useApp((s) => s.viewedFile);
  const [preview, setPreview] = useState(true);

  // For artifacts, prefer `raw` (frontmatter + body) so the preview can
  // render the frontmatter as an `.fm-table` like skillsafe.ai/web does.
  const showing = viewedFile ?? (artifact
    ? { name: artifact.name, path: artifact.path, content: artifact.raw || artifact.body, language: "markdown" }
    : { name: "", path: "", content: "", language: "markdown" });
  const isMarkdown = showing.language === "markdown";
  const isImage = showing.language === "image";
  const showPreview = isMarkdown && preview;

  const previewHtml = useMemo(
    () => (showPreview ? renderMarkdown(showing.content) : ""),
    [showPreview, showing.content],
  );

  if (!artifact) {
    return (
      <section className="editor-pane">
        <div className="empty">Select an artifact on the left to view.</div>
      </section>
    );
  }

  return (
    <section className="editor-pane">
      <div className="editor-toolbar">
        <div className="editor-title">{showing.name}</div>
        {isMarkdown && (
          <button onClick={() => setPreview((p) => !p)}>
            {preview ? "Source" : "Preview"}
          </button>
        )}
      </div>
      <div className="body-only">
        {isImage ? (
          <div className="img-preview">
            <img src={convertFileSrc(showing.path)} alt={showing.name} />
          </div>
        ) : showPreview ? (
          <div className="md-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        ) : (
          <Monaco
            key={showing.path}
            height="100%"
            language={showing.language}
            theme={theme === "light" ? "vs" : "vs-dark"}
            value={showing.content}
            onMount={(editor) => requestAnimationFrame(() => editor.layout())}
            options={{
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 13,
              scrollBeyondLastLine: false,
              readOnly: true,
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </section>
  );
}

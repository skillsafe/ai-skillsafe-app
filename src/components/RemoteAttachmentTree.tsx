import { useState } from "react";
import type { Attachment } from "../lib/artifacts/types";
import { useApp } from "../lib/store";
import { downloadBlob, SkillSafeError } from "../lib/skillsafe/client";
import { TreeView } from "./TreeView";

const TEXT_EXT = new Set([
  "md", "mdx", "markdown", "txt", "log", "rst", "tex",
  "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "cs",
  "sh", "bash", "zsh", "fish", "ps1",
  "json", "yaml", "yml", "toml", "ini", "env", "conf",
  "html", "htm", "xml", "svg", "css", "scss", "sass",
  "sql", "graphql", "gql",
  "dockerfile", "makefile", "gitignore", "csv", "tsv",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

function ext(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}
function isText(name: string): boolean {
  if (TEXT_EXT.has(ext(name))) return true;
  const lower = name.toLowerCase();
  return ["readme", "license", "dockerfile", "makefile"].some((b) => lower.includes(b));
}
function isImage(name: string): boolean { return IMAGE_EXT.has(ext(name)); }

function inferLanguage(name: string): string {
  const e = ext(name);
  const map: Record<string, string> = {
    md: "markdown", mdx: "markdown", markdown: "markdown",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    swift: "swift", c: "c", cc: "cpp", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell",
    json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
    html: "html", htm: "html", xml: "xml", svg: "xml",
    css: "css", scss: "scss", sass: "scss",
    sql: "sql", graphql: "graphql", gql: "graphql",
    csv: "plaintext", tsv: "plaintext", txt: "plaintext", log: "plaintext",
  };
  return map[e] ?? "plaintext";
}

interface Props {
  artifactId: string;
  artifactPath: string;     // display label for the SKILL.md row
  attachments: Attachment[];
  pathToHash: Record<string, string>;
  skillMdPath?: string;
  skillBody?: string;
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function RemoteAttachmentTree({
  attachments,
  pathToHash,
  skillMdPath,
  skillBody,
  onToast,
}: Props) {
  const cloudApiKey = useApp((s) => s.cloudApiKey);
  const remoteViewedFile = useApp((s) => s.remoteViewedFile);
  const setRemoteViewedFile = useApp((s) => s.setRemoteViewedFile);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  async function handleOpen(node: Attachment) {
    if (node.isDir) return;
    const hash = pathToHash[node.path];
    if (!hash) {
      onToast("error", `No blob hash for ${node.path}`);
      return;
    }
    if (!isText(node.name) && !isImage(node.name)) {
      onToast("error", `Cannot preview ${node.name} in app.`);
      return;
    }
    setLoadingPath(node.path);
    try {
      const bytes = await downloadBlob(hash, cloudApiKey);
      if (isImage(node.name)) {
        const blob = new Blob([new Uint8Array(bytes).buffer]);
        const url = URL.createObjectURL(blob);
        setRemoteViewedFile({ name: node.name, path: node.path, content: url, language: "image" });
      } else {
        const content = new TextDecoder().decode(bytes);
        setRemoteViewedFile({
          name: node.name,
          path: node.path,
          content,
          language: inferLanguage(node.name),
        });
      }
    } catch (e) {
      const msg = e instanceof SkillSafeError ? `${e.code}: ${e.message}` : String(e);
      onToast("error", `Download failed: ${msg}`);
    } finally {
      setLoadingPath(null);
    }
  }

  const skillActive = !remoteViewedFile;
  const activePath = remoteViewedFile?.path ?? null;

  return (
    <TreeView
      attachments={attachments.filter((a) => !skillMdPath || a.path !== skillMdPath)}
      topItem={
        skillMdPath && skillBody !== undefined
          ? {
              name: skillMdPath,
              path: skillMdPath,
              active: skillActive,
              onOpen: () => setRemoteViewedFile(null),
            }
          : undefined
      }
      activePath={activePath}
      loadingPath={loadingPath}
      onOpen={handleOpen}
    />
  );
}

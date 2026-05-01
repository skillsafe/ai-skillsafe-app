import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { Attachment } from "../lib/artifacts/types";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner } from "../lib/tauriAdapters";
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
  const e = ext(name);
  if (TEXT_EXT.has(e)) return true;
  // Common dotfiles/no-extension that are text
  const lower = name.toLowerCase();
  return ["readme", "license", "dockerfile", "makefile"].some((b) => lower.includes(b));
}

function isImage(name: string): boolean {
  return IMAGE_EXT.has(ext(name));
}

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
  attachments: Attachment[];
  bundleDir?: string;
  skillName?: string;
  skillBody?: string;
}

export function AttachmentTree({ attachments, bundleDir, skillName, skillBody }: Props) {
  const viewedFile = useApp((s) => s.viewedFile);
  const setViewedFile = useApp((s) => s.setViewedFile);

  async function handleOpen(node: Attachment) {
    if (node.isDir) return;
    if (isText(node.name)) {
      try {
        const content = await tauriFs.readTextFile(node.path);
        setViewedFile({
          name: node.name,
          path: node.path,
          content,
          language: inferLanguage(node.name),
        });
      } catch (e) {
        console.error("Failed to read file:", e);
        shellOpen(node.path);
      }
    } else if (isImage(node.name)) {
      // Tauri converts file:// URLs via the asset: protocol; use the http fallback
      setViewedFile({
        name: node.name,
        path: node.path,
        content: node.path,
        language: "image",
      });
    } else {
      shellOpen(node.path);
    }
  }

  async function handleOpenSkill() {
    if (!bundleDir || !skillName || skillBody === undefined) return;
    const skillPath = await tauriJoiner.join(bundleDir, "SKILL.md");
    setViewedFile({
      name: "SKILL.md",
      path: skillPath,
      content: skillBody,
      language: "markdown",
    });
  }

  const skillActive = !viewedFile || viewedFile.name === "SKILL.md";

  return (
    <TreeView
      attachments={attachments}
      topItem={
        bundleDir && skillName
          ? {
              name: "SKILL.md",
              path: `${bundleDir}/SKILL.md`,
              active: skillActive,
              onOpen: handleOpenSkill,
            }
          : undefined
      }
      activePath={viewedFile?.path ?? null}
      onOpen={handleOpen}
    />
  );
}

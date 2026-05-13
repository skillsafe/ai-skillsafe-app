// Shared file-tree renderer matching the skillsafe.ai website's skill page.
// Uses SVG icons (chevron + folder + per-extension file icons), shows a
// "<n> files" header, file size on the right, and styles via the CSS classes
// `.files-tree-wrap`, `.file-tree-header`, `.file-tree`, `.tree-folder`,
// `.tree-folder-header`, `.tree-folder-children`, `.tree-chevron`,
// `.tree-folder-icon`, `.tree-folder-name`, `.file-item`, `.file-name`,
// `.file-size`.
import { useTranslation } from "react-i18next";
import type { Attachment } from "../lib/artifacts/types";

function formatBytes(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ext(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function ChevronIcon() {
  return (
    <svg
      className="tree-chevron"
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      className="tree-folder-icon"
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="var(--accent-soft)"
      stroke="var(--accent)"
      strokeWidth="1.5"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon({ name }: { name: string }) {
  const e = ext(name);
  if (["md", "mdx", "markdown"].includes(e)) {
    return (
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="12" y2="17" />
      </svg>
    );
  }
  if (
    [
      "js", "mjs", "cjs", "ts", "tsx", "jsx", "mts", "cts",
      "py", "rb", "go", "rs", "java", "kt", "swift",
      "c", "cc", "cpp", "h", "hpp", "cs",
      "sh", "bash", "zsh", "fish", "ps1",
    ].includes(e)
  ) {
    return (
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    );
  }
  if (["json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env"].includes(e)) {
    return (
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    );
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"].includes(e)) {
    return (
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function containsActive(nodes: Attachment[], activePath: string | null): boolean {
  if (!activePath) return false;
  for (const n of nodes) {
    if (!n.isDir && n.path === activePath) return true;
    if (n.isDir && n.children && containsActive(n.children, activePath)) return true;
  }
  return false;
}

interface NodeProps {
  node: Attachment;
  depth: number;
  activePath: string | null;
  loadingPath?: string | null;
  onOpen: (node: Attachment) => void;
}

function Node({ node, depth, activePath, loadingPath, onOpen }: NodeProps) {
  const indent = 12 + depth * 16;
  if (node.isDir) {
    const onPath = containsActive(node.children ?? [], activePath);
    return (
      <details className={`tree-folder ${onPath ? "tree-folder-active" : ""}`} open>
        <summary className="tree-folder-header" style={{ paddingLeft: indent }}>
          <ChevronIcon />
          <FolderIcon />
          <span className="tree-folder-name">{node.name}</span>
        </summary>
        <div className="tree-folder-children">
          {(node.children ?? []).map((c) => (
            <Node
              key={c.path}
              node={c}
              depth={depth + 1}
              activePath={activePath}
              loadingPath={loadingPath}
              onOpen={onOpen}
            />
          ))}
        </div>
      </details>
    );
  }
  const active = node.path === activePath;
  const isLoading = node.path === loadingPath;
  return (
    <div
      className={`file-item ${active ? "active" : ""}`}
      style={{ paddingLeft: indent }}
      role="button"
      tabIndex={0}
      title={node.path}
      onClick={() => onOpen(node)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(node);
        }
      }}
    >
      <FileIcon name={node.name} />
      <span className="file-name">
        {node.name}
        {isLoading ? "…" : ""}
      </span>
      {node.size > 0 && <span className="file-size">{formatBytes(node.size)}</span>}
    </div>
  );
}

export interface TopItem {
  name: string;
  path: string;
  active: boolean;
  size?: number;
  onOpen: () => void;
}

interface TreeViewProps {
  attachments: Attachment[];
  topItem?: TopItem;
  activePath: string | null;
  loadingPath?: string | null;
  onOpen: (node: Attachment) => void;
}

function countFiles(nodes: Attachment[]): number {
  let n = 0;
  for (const a of nodes) {
    if (a.isDir) n += countFiles(a.children ?? []);
    else n += 1;
  }
  return n;
}

export function TreeView({ attachments, topItem, activePath, loadingPath, onOpen }: TreeViewProps) {
  const { t } = useTranslation();
  const total = countFiles(attachments) + (topItem ? 1 : 0);
  return (
    <div className="files-tree-wrap">
      <div className="file-tree-header">
        <FolderIcon />
        <span>{t("treeView.fileCount", { count: total })}</span>
      </div>
      <div className="file-tree">
        {topItem && (
          <div
            className={`file-item ${topItem.active ? "active" : ""}`}
            style={{ paddingLeft: 12 }}
            role="button"
            tabIndex={0}
            title={topItem.path}
            onClick={topItem.onOpen}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                topItem.onOpen();
              }
            }}
          >
            <FileIcon name={topItem.name} />
            <span className="file-name">{topItem.name}</span>
            {topItem.size && topItem.size > 0 ? (
              <span className="file-size">{formatBytes(topItem.size)}</span>
            ) : null}
          </div>
        )}
        {attachments.map((a) => (
          <Node
            key={a.path}
            node={a}
            depth={0}
            activePath={activePath}
            loadingPath={loadingPath}
            onOpen={onOpen}
          />
        ))}
        {attachments.length === 0 && !topItem && (
          <div className="tree-empty">{t("treeView.empty")}</div>
        )}
      </div>
    </div>
  );
}

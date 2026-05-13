import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { Attachment } from "../lib/artifacts/types";
import {
  MAX_PREVIEW_BYTES,
  PREVIEW_LANG,
  inferLanguage,
  isImage,
  isLikelyBinary,
  looksLikeBinaryBytes,
} from "../lib/preview/fileClassify";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner } from "../lib/tauriAdapters";
import { TreeView } from "./TreeView";

interface Props {
  attachments: Attachment[];
  bundleDir?: string;
  skillName?: string;
  skillBody?: string;
  /** Forwarded to TreeView. Default true matches the historical
   *  always-expanded skill-bundle preview; CategoryBrowser passes false. */
  defaultExpanded?: boolean;
  /** Lazy-load callback fired the first time a folder opens. CategoryBrowser
   *  uses this to walk per-project subtrees on demand. */
  onExpandFolder?: (node: Attachment) => void;
  /** Set of dir paths currently being walked. Folders in this set show a
   *  "Loading…" hint while their children are still empty. */
  loadingFolders?: ReadonlySet<string>;
}

export function AttachmentTree({
  attachments,
  bundleDir,
  skillName,
  skillBody,
  defaultExpanded,
  onExpandFolder,
  loadingFolders,
}: Props) {
  const viewedFile = useApp((s) => s.viewedFile);
  const setViewedFile = useApp((s) => s.setViewedFile);

  async function handleOpen(node: Attachment) {
    if (node.isDir) return;

    if (isImage(node.name)) {
      setViewedFile({
        name: node.name,
        path: node.path,
        content: node.path,
        language: PREVIEW_LANG.image,
      });
      return;
    }

    if (isLikelyBinary(node.name)) {
      shellOpen(node.path);
      return;
    }

    // Anything else: try to read as text. Size-guard + NUL-byte sniff
    // protect us from misnamed binaries or huge log files.
    try {
      const s = await tauriFs.stat(node.path);
      if (s.size > MAX_PREVIEW_BYTES) {
        setViewedFile({
          name: node.name,
          path: node.path,
          content: String(s.size),
          language: PREVIEW_LANG.tooLarge,
        });
        return;
      }
      // readFile is optional on the adapter for mocks, but the live Tauri
      // adapter always defines it (tauriAdapters.ts).
      const bytes = await tauriFs.readFile!(node.path);
      if (looksLikeBinaryBytes(bytes)) {
        shellOpen(node.path);
        return;
      }
      const content = new TextDecoder().decode(bytes);
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
      defaultExpanded={defaultExpanded}
      onExpandFolder={onExpandFolder}
      loadingFolders={loadingFolders}
      onOpen={handleOpen}
    />
  );
}

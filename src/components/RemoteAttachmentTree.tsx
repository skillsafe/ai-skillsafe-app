import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { downloadBlob, SkillSafeError } from "../lib/skillsafe/client";
import { TreeView } from "./TreeView";

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
  const { t } = useTranslation();
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
    if (isLikelyBinary(node.name)) {
      onToast("error", t("remoteEditor.binaryToast", { name: node.name }));
      return;
    }
    setLoadingPath(node.path);
    try {
      const bytes = await downloadBlob(hash, cloudApiKey);
      if (isImage(node.name)) {
        const blob = new Blob([new Uint8Array(bytes).buffer]);
        const url = URL.createObjectURL(blob);
        setRemoteViewedFile({ name: node.name, path: node.path, content: url, language: PREVIEW_LANG.image });
        return;
      }
      const byteArr = new Uint8Array(bytes);
      if (byteArr.length > MAX_PREVIEW_BYTES) {
        setRemoteViewedFile({
          name: node.name,
          path: node.path,
          content: String(byteArr.length),
          language: PREVIEW_LANG.tooLarge,
        });
        return;
      }
      if (looksLikeBinaryBytes(byteArr)) {
        onToast("error", t("remoteEditor.binaryToast", { name: node.name }));
        return;
      }
      const content = new TextDecoder().decode(byteArr);
      setRemoteViewedFile({
        name: node.name,
        path: node.path,
        content,
        language: inferLanguage(node.name),
      });
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

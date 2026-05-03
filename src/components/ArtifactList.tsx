import { useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { AttachmentTree } from "./AttachmentTree";
import { ArchiveIcon, TrashIcon, UploadCloudIcon } from "./icons";
import type { MarkdownArtifact } from "../lib/artifacts/types";

interface Props {
  onNew: () => void;
  onConvert: () => void;
  onReload: () => void;
  onDelete: (artifact: MarkdownArtifact) => void;
  onBackup: (artifact: MarkdownArtifact) => void;
  onUpload: (artifact: MarkdownArtifact) => void;
}

export function ArtifactList({
  onNew,
  onConvert,
  onReload,
  onDelete,
  onBackup,
  onUpload,
}: Props) {
  const {
    artifacts,
    selectedId,
    setSelectedId,
    driftByName,
    error,
    recentProjects,
    scope,
    backupDestination,
    cloudApiKey,
  } = useApp();
  const [query, setQuery] = useState("");

  // Map project root → display name (last folder segment) so artifact cards
  // can show which project they came from when aggregating multiple roots.
  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of recentProjects) {
      const segments = p.replace(/\/+$/, "").split(/[\\/]/);
      m.set(p, segments[segments.length - 1] || p);
    }
    return m;
  }, [recentProjects]);
  const projectRootForArtifact = (id: string): string | null => {
    // Aggregated artifacts have id `${projectRoot}::${origId}` — see App.tsx.
    const idx = id.indexOf("::");
    if (idx < 0) return null;
    return id.slice(0, idx);
  };

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return artifacts;
    return artifacts.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        String(a.frontmatter.description ?? "")
          .toLowerCase()
          .includes(q),
    );
  }, [artifacts, query]);

  return (
    <section className="list-pane">
      <div className="list-toolbar">
        <input
          className="search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={onNew} title="Create artifact">+ New</button>
        <button
          onClick={onConvert}
          disabled={!selectedId}
          aria-label="Convert selected artifact to another tool"
          title="Convert to other tool"
        >
          →
        </button>
        <button onClick={onReload} aria-label="Reload artifact list" title="Reload">
          ↻
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className="empty">
          {artifacts.length === 0 ? "No artifacts in this scope yet." : "No matches."}
          {error && <div className="empty-error">{error}</div>}
        </div>
      ) : (
        filtered.map((a) => {
          const drift = driftByName[a.name] === true;
          const desc = String(a.frontmatter.description ?? "").trim();
          const isActive = selectedId === a.id;
          const canUpload = a.isBundle && !!a.bundleDir;
          return (
            <div key={a.id}>
              <div
                className={`artifact-card ${isActive ? "active" : ""}`}
                onClick={() => setSelectedId(isActive ? null : a.id)}
              >
                <div className="artifact-name">
                  {a.name}
                  {drift && <span className="badge drift">drift</span>}
                </div>
                {desc && <div className="artifact-desc">{truncate(desc, 160)}</div>}
                <div className="artifact-meta">
                  <span>{a.tool}</span>
                  {(scope === "project" || scope === "lockfile") && (() => {
                    const root = projectRootForArtifact(a.id);
                    const name = root ? projectName.get(root) : null;
                    return name ? (
                      <>
                        <span>·</span>
                        <span title={root ?? ""} className="artifact-project">{name}</span>
                      </>
                    ) : null;
                  })()}
                  {a.mtimeMs ? (
                    <>
                      <span>·</span>
                      <span>{new Date(a.mtimeMs).toLocaleString()}</span>
                    </>
                  ) : null}
                </div>
                <div className="card-actions">
                  <button
                    className="icon-btn"
                    aria-label={`Back up ${a.name}`}
                    title={
                      backupDestination
                        ? "Back up this skill to the backup folder"
                        : "Set a backup folder in Settings → Local Backup first"
                    }
                    disabled={!backupDestination}
                    onClick={(e) => { e.stopPropagation(); onBackup(a); }}
                  >
                    <ArchiveIcon size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Upload ${a.name} to skillsafe.ai`}
                    title={
                      !canUpload
                        ? "Only bundle skills (with SKILL.md) can be uploaded"
                        : !cloudApiKey
                          ? "Sign in via Settings to upload"
                          : "Upload to skillsafe.ai"
                    }
                    disabled={!canUpload || !cloudApiKey}
                    onClick={(e) => { e.stopPropagation(); onUpload(a); }}
                  >
                    <UploadCloudIcon size={14} />
                  </button>
                  <button
                    className="icon-btn danger"
                    aria-label={`Delete ${a.name}`}
                    title="Delete from disk"
                    onClick={(e) => { e.stopPropagation(); onDelete(a); }}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>
              {isActive && a.isBundle && (
                <div className="card-tree">
                  <AttachmentTree
                    attachments={a.attachments}
                    bundleDir={a.bundleDir}
                    skillName={a.name}
                    skillBody={a.body}
                  />
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

import { useEffect, useMemo, useState } from "react";
import Monaco from "@monaco-editor/react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { restoreFromBackup } from "../lib/backup/single";
import {
  BACKUP_SUBDIR,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  parseManifest,
  toolBackupSubdir,
  type BackupEntry,
  type BackupManifest,
} from "../lib/backup/manifest";
import type { ArtifactType, Scope, Tool } from "../lib/artifacts/types";
import { ALL_AGENTS, displayNameOf } from "../lib/agents/registry";
import { resolveArtifactDir } from "../lib/paths";
import { renderMarkdown } from "../lib/markdown";
import { parseFrontmatter } from "../lib/frontmatter";
import { ArchiveIcon } from "./icons";
import { TreeView } from "./TreeView";
import type { Attachment } from "../lib/artifacts/types";
import { ConfirmDialog } from "./ConfirmDialog";

const ALL_TOOLS: ReadonlyArray<{ id: Tool; label: string }> = ALL_AGENTS
  .map((id) => ({ id, label: displayNameOf(id) }))
  .sort((a, b) => a.label.localeCompare(b.label));

type Group = "skill" | "agent" | "command" | "history";
type ScopeFilter = "all" | "global" | "project";

const GROUP_LABEL: Record<Group, string> = {
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
  history: "History",
};

interface BrowserFile {
  entry: BackupEntry;
  // Path within the item (i.e. what follows the bundle / project root).
  relInItem: string;
}

interface BrowserItem {
  id: string;
  label: string;
  sub?: string;
  // Tags shown as badges next to the label (e.g. "skill", "global").
  badges: string[];
  // One-line context shown below the bytes summary (e.g. project name).
  meta?: string;
  files: BrowserFile[];
  // Path of the SKILL.md / single .md file used to source the description.
  primaryMdAbs?: string;
}

interface FileTreeNode {
  name: string;
  path: string; // path within the item
  isDir: boolean;
  file?: BrowserFile;
  children: FileTreeNode[];
}

interface Props {
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function BackupBrowser({ onToast }: Props) {
  const {
    backupDestination,
    backupLastRun,
    backupStats,
    backupBusy,
    backupProgress,
    resolvedTheme,
    setShowSettings,
    setSettingsScrollTarget,
  } = useApp();

  function openBackupSettings() {
    setSettingsScrollTarget("settings-backup");
    setShowSettings(true);
  }

  // No backup folder configured → take the user straight to Settings →
  // Local Backup instead of showing a placeholder/empty state. Fires once
  // per missing-destination state; if the user closes Settings without
  // picking a folder, they can still click the panel button to retry.
  useEffect(() => {
    if (!backupDestination) {
      setSettingsScrollTarget("settings-backup");
      setShowSettings(true);
    }
  }, [backupDestination, setSettingsScrollTarget, setShowSettings]);
  const [manifest, setManifest] = useState<BackupManifest | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Restore confirmation: pending = item the user clicked Restore on.
  // targetExists = whether the resolved restore destination already has files
  // (so the dialog can warn about overwrite).
  const [restorePending, setRestorePending] = useState<BrowserItem | null>(null);
  const [restoreTargetDir, setRestoreTargetDir] = useState<string>("");
  const [restoreTargetExists, setRestoreTargetExists] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [selectedTool, setSelectedTool] = useState<Tool | "all">("all");
  const [group, setGroup] = useState<Group | "all">("all");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<BackupEntry | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileBinary, setFileBinary] = useState(false);

  // Load manifest on destination / last-run change.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!backupDestination) {
        setManifest(null);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        // Per-tool layout: read each <dest>/<tool>_backup/LAST_BACKUP.json
        // and merge into one in-memory manifest for the existing UI. Fall
        // back to the older single-manifest layouts when no per-tool
        // manifests are present.
        const partials: BackupManifest[] = [];
        for (const t of ALL_TOOLS) {
          const path = await tauriJoiner.join(
            backupDestination,
            toolBackupSubdir(t.id),
            MANIFEST_FILENAME,
          );
          if (!(await tauriFs.exists(path))) continue;
          try {
            const text = await tauriFs.readTextFile(path);
            const m = parseManifest(text);
            if (m) partials.push(m);
          } catch {
            // Skip unreadable per-tool manifests; surface a generic error
            // below if NONE could be loaded.
          }
        }
        if (cancelled) return;
        if (partials.length > 0) {
          setManifest(mergeToolManifests(partials, backupDestination));
          return;
        }
        // Legacy fallback: pre-per-tool layouts had a single manifest at
        // <dest>/LAST_BACKUP.json or <dest>/skillsafe-backup/LAST_BACKUP.json.
        let legacyPath = await tauriJoiner.join(backupDestination, MANIFEST_FILENAME);
        if (!(await tauriFs.exists(legacyPath))) {
          legacyPath = await tauriJoiner.join(
            backupDestination,
            BACKUP_SUBDIR,
            MANIFEST_FILENAME,
          );
        }
        if (await tauriFs.exists(legacyPath)) {
          const text = await tauriFs.readTextFile(legacyPath);
          if (cancelled) return;
          const m = parseManifest(text);
          setManifest(m);
          if (!m) setLoadError("Manifest file is unreadable.");
          return;
        }
        setManifest(null);
      } catch (e) {
        if (cancelled) return;
        setManifest(null);
        setLoadError(
          e instanceof Error ? `Couldn't read backup manifest: ${e.message}` : "Couldn't read backup manifest.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [backupDestination, backupLastRun]);

  const toolCounts = useMemo(() => countArtifactsByTool(manifest), [manifest]);

  // Tool pills only render when the user has actually backed something up for
  // that tool. The "All" pill is always available so the user can browse
  // across tools.
  const visibleTools = useMemo(
    () => ALL_TOOLS.filter((t) => (toolCounts[t.id] ?? 0) > 0),
    [toolCounts],
  );
  const totalToolItems = useMemo(
    () => visibleTools.reduce((n, t) => n + (toolCounts[t.id] ?? 0), 0),
    [visibleTools, toolCounts],
  );

  // For the currently-selected tool (or "all"), which groups exist?
  // (skill/agent/command come from artifact entries; history maps to
  // claude/projects entries — included only when the tool filter
  // includes claude.)
  const groupCounts = useMemo(() => {
    const acc: Partial<Record<Group, number>> = {};
    if (!manifest) return acc;
    const includeClaude = selectedTool === "all" || selectedTool === "claude";
    for (const e of manifest.entries) {
      if (e.kind === "project") {
        if (includeClaude) acc.history = (acc.history ?? 0) + 1;
        continue;
      }
      if (e.kind !== "artifact") continue;
      if (selectedTool !== "all" && e.tool !== selectedTool) continue;
      const g = e.type as Group | undefined;
      if (g === "skill" || g === "agent" || g === "command") {
        acc[g] = (acc[g] ?? 0) + 1;
      }
    }
    return acc;
  }, [manifest, selectedTool]);

  const totalGroupItems = useMemo(
    () =>
      (groupCounts.skill ?? 0) +
      (groupCounts.agent ?? 0) +
      (groupCounts.command ?? 0) +
      (groupCounts.history ?? 0),
    [groupCounts],
  );

  // Within the selected tool+group, which scopes are present? History
  // entries have no scope, so they're naturally excluded; the Scope row
  // hides itself when no scoped artifacts are visible.
  const scopeCounts = useMemo(() => {
    const acc: Record<"global" | "project", number> = { global: 0, project: 0 };
    if (!manifest) return acc;
    for (const e of manifest.entries) {
      if (e.kind !== "artifact") continue;
      if (selectedTool !== "all" && e.tool !== selectedTool) continue;
      if (group !== "all" && e.type !== group) continue;
      if (e.scope === "global") acc.global += 1;
      else if (e.scope === "project") acc.project += 1;
    }
    return acc;
  }, [manifest, selectedTool, group]);

  const [filter, setFilter] = useState("");

  const items: BrowserItem[] = useMemo(() => {
    if (!manifest) return [];
    const base = collectBrowserItems(manifest, selectedTool, group, scopeFilter);
    const q = filter.toLowerCase().trim();
    if (!q) return base;
    return base.filter((i) =>
      i.label.toLowerCase().includes(q) ||
      (i.sub ?? "").toLowerCase().includes(q),
    );
  }, [manifest, group, selectedTool, scopeFilter, filter]);

  // Auto-jump only when the user lands on an empty selection. With "All"
  // available we never need to override their explicit choice — the
  // fallbacks only fire when a specific tool/group has zero items.
  useEffect(() => {
    if (!manifest) return;
    if (selectedTool === "all") return;
    if ((toolCounts[selectedTool] ?? 0) > 0) return;
    setSelectedTool("all");
  }, [manifest, toolCounts, selectedTool]);

  useEffect(() => {
    if (!manifest) return;
    if (group === "all") return;
    if ((groupCounts[group] ?? 0) > 0) return;
    setGroup("all");
  }, [manifest, groupCounts, group]);

  // If the current scope filter has no entries, fall back to "all".
  useEffect(() => {
    if (scopeFilter === "all") return;
    if ((scopeCounts[scopeFilter] ?? 0) === 0) setScopeFilter("all");
  }, [scopeCounts, scopeFilter]);

  // Auto-select the first item only when the *filter set* changes (new
  // manifest, view, tool, or query). Re-running on selectedItemId changes
  // would override the user's click-to-collapse gesture immediately.
  useEffect(() => {
    if (items.length === 0) {
      setSelectedItemId(null);
      return;
    }
    setSelectedItemId(items[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, group, selectedTool, scopeFilter, filter]);

  const selectedItem = items.find((i) => i.id === selectedItemId) ?? null;

  // Auto-select preferred file (SKILL.md → first .md → first file).
  useEffect(() => {
    if (!selectedItem) {
      setSelectedFile(null);
      return;
    }
    const skillMd = selectedItem.files.find(
      (f) => fileBasename(f.entry.relPath).toLowerCase() === "skill.md",
    );
    const anyMd = selectedItem.files.find(
      (f) => fileBasename(f.entry.relPath).toLowerCase().endsWith(".md"),
    );
    const choice = skillMd ?? anyMd ?? selectedItem.files[0];
    setSelectedFile(choice ? choice.entry : null);
  }, [selectedItem]);

  // Fetch description from each item's primary .md frontmatter. Lazy and
  // cached: an item is fetched once per session.
  const [descriptions, setDescriptions] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let cancelled = false;
    async function fetchDescriptions() {
      const todo = items.filter(
        (i) => i.primaryMdAbs && descriptions[i.id] === undefined,
      );
      if (todo.length === 0) return;
      // Read sequentially to avoid hammering the FS plugin.
      for (const item of todo) {
        if (cancelled) return;
        try {
          const text = await tauriFs.readTextFile(item.primaryMdAbs!);
          const fm = parseFrontmatter(text);
          const desc = String(fm.data.description ?? "").trim();
          setDescriptions((prev) => ({ ...prev, [item.id]: desc || null }));
        } catch {
          setDescriptions((prev) => ({ ...prev, [item.id]: null }));
        }
      }
    }
    fetchDescriptions();
    return () => {
      cancelled = true;
    };
  }, [items]);

  // Load selected file's content for preview.
  useEffect(() => {
    let cancelled = false;
    async function loadFile() {
      if (!selectedFile) {
        setFileContent(null);
        setFileBinary(false);
        return;
      }
      setFileLoading(true);
      setFileBinary(false);
      try {
        if (isLikelyBinary(selectedFile.relPath)) {
          if (cancelled) return;
          setFileContent(null);
          setFileBinary(true);
          return;
        }
        const text = await tauriFs.readTextFile(selectedFile.destPath);
        if (cancelled) return;
        setFileContent(text);
      } catch (e) {
        if (cancelled) return;
        setFileContent(`Could not read file:\n${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    }
    loadFile();
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  async function openExternally(destPath: string) {
    try {
      await shellOpen(destPath);
    } catch (e) {
      onToast("error", `Open failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function startRestore(item: BrowserItem) {
    const firstEntry = item.files[0]?.entry;
    if (!firstEntry || firstEntry.kind !== "artifact") return;
    if (!firstEntry.tool || !firstEntry.scope || !firstEntry.type) {
      onToast("error", "Backup entry is missing tool/scope/type — can't restore.");
      return;
    }
    if (firstEntry.scope === "project" && !firstEntry.projectRoot) {
      onToast("error", "Project-scoped backup is missing its project root — can't restore.");
      return;
    }
    try {
      const baseDir = await resolveArtifactDir(
        tauriPaths,
        firstEntry.tool,
        firstEntry.scope as Exclude<Scope, "all">,
        firstEntry.type as Exclude<ArtifactType, "all">,
        firstEntry.projectRoot ?? undefined,
      );
      const targetDir = firstEntry.type === "skill"
        ? await tauriJoiner.join(baseDir, item.label)
        : baseDir;
      const exists = await tauriFs.exists(targetDir);
      setRestoreTargetDir(targetDir);
      setRestoreTargetExists(exists);
      setRestorePending(item);
    } catch (e) {
      onToast("error", `Couldn't resolve restore target: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function confirmRestore() {
    const item = restorePending;
    if (!item) return;
    const firstEntry = item.files[0]?.entry;
    if (!firstEntry || firstEntry.kind !== "artifact" || !firstEntry.tool || !firstEntry.scope || !firstEntry.type) {
      setRestorePending(null);
      return;
    }
    setRestoreBusy(true);
    try {
      const result = await restoreFromBackup({
        fs: tauriFs,
        paths: tauriPaths,
        joiner: tauriJoiner,
        tool: firstEntry.tool,
        scope: firstEntry.scope as Exclude<Scope, "all" | "lockfile">,
        type: firstEntry.type as Exclude<ArtifactType, "all">,
        projectRoot: firstEntry.projectRoot,
        bundleName: firstEntry.type === "skill" ? item.label : undefined,
        files: item.files.map((f) => ({
          source: f.entry.destPath,
          relInItem: f.relInItem,
        })),
      });
      onToast(
        "ok",
        `Restored ${result.written.length} file${result.written.length === 1 ? "" : "s"} → ${result.targetDir}`,
      );
      setRestorePending(null);
    } catch (e) {
      onToast("error", `Restore failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRestoreBusy(false);
    }
  }

  // Empty states (mirror cloud panel's empty state styling).
  // No destination → useEffect above auto-opens Settings. Render an empty
  // shell so the panel area isn't a flash of "set things up here" copy.
  if (!backupDestination) return <BackupEmpty />;
  if (loading && !manifest) return <BackupEmpty>Loading backup manifest…</BackupEmpty>;
  if (!manifest) {
    return (
      <BackupEmpty>
        <div className="backup-empty-title">
          {loadError ?? "No backup found at this folder yet."}
        </div>
        <div className="backup-empty-action">
          Open <strong>Settings → Local Backup</strong> and click{" "}
          <strong>Back up now</strong> to create one.
        </div>
      </BackupEmpty>
    );
  }

  // Layout = 3 panes (mirrors CloudInfoPane | RemoteList | RemoteEditor).
  return (
    <>
      {/* Pane 1: backup controls + browse filters, styled like CloudInfoPane */}
      <aside className="sidebar cloud-info-pane">
        <div className="brand">
          <span className="brand-globe"><ArchiveIcon size={18} /></span>
          <div className="brand-title">Local Backup</div>
        </div>

        <div className="settings-row" style={{ paddingLeft: 6 }}>
          <button
            className="primary"
            onClick={openBackupSettings}
            disabled={backupBusy}
            title={
              backupBusy
                ? "Backup in progress…"
                : "Pick which tools to back up and run the backup"
            }
          >
            {backupBusy ? "Backing up…" : "Configure & back up…"}
          </button>
        </div>

        <div className="section-label">Tools</div>
        <div className="pill-row" style={{ flexWrap: "wrap" }}>
          {visibleTools.length === 0 ? (
            <div className="empty" style={{ padding: 0 }}>
              Nothing backed up yet — click "Back up now" to start.
            </div>
          ) : (
            <>
              <div
                className={`pill ${selectedTool === "all" ? "active" : ""}`}
                onClick={() => setSelectedTool("all")}
                role="tab"
                aria-selected={selectedTool === "all"}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    setSelectedTool("all");
                  }
                }}
                title={`Browse content from every tool · ${totalToolItems} backed up`}
              >
                All
                <span className="backup-tool-count">{totalToolItems}</span>
              </div>
              {visibleTools.map((t) => {
                const count = toolCounts[t.id] ?? 0;
                return (
                  <div
                    key={t.id}
                    className={`pill ${selectedTool === t.id ? "active" : ""}`}
                    onClick={() => setSelectedTool(t.id)}
                    role="tab"
                    aria-selected={selectedTool === t.id}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        setSelectedTool(t.id);
                      }
                    }}
                    title={`${t.label} · ${count} backed up`}
                  >
                    {t.label}
                    <span className="backup-tool-count">{count}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {backupBusy && backupProgress && (
          <div className="dl-progress" role="status" aria-live="polite" style={{ paddingLeft: 6 }}>
            <div className="dl-progress-bar">
              <div className="dl-progress-fill backup-progress-indeterminate" />
            </div>
            <div className="dl-progress-label">
              {backupProgress.phase} · scanned {backupProgress.filesProcessed} ({formatBytes(backupProgress.bytesProcessed)})
              · copied {backupProgress.filesCopied} ({formatBytes(backupProgress.bytesCopied)})
            </div>
          </div>
        )}

        <div className="backup-last-run">
          {backupLastRun && backupStats ? (
            <>
              Last backup: {formatRelative(backupLastRun)} · +{backupStats.counts.added} ~
              {backupStats.counts.changed} -{backupStats.counts.removed} ·{" "}
              {formatBytes(backupStats.totalBytes)}
            </>
          ) : (
            "Never backed up"
          )}
        </div>

        <div className="section-label">Group</div>
        <div className="pill-row" style={{ flexWrap: "wrap" }}>
          <div
            className={`pill ${group === "all" ? "active" : ""}`}
            onClick={() => setGroup("all")}
            role="tab"
            aria-selected={group === "all"}
          >
            All
            <span className="backup-tool-count">{totalGroupItems}</span>
          </div>
          {(["skill", "agent", "command", "history"] as Group[]).map((g) => {
            const count = groupCounts[g] ?? 0;
            const enabled = count > 0;
            return (
              <div
                key={g}
                className={`pill ${group === g ? "active" : ""} ${enabled ? "" : "disabled"}`}
                onClick={() => enabled && setGroup(g)}
                role="tab"
                aria-selected={group === g}
              >
                {GROUP_LABEL[g]}
                <span className="backup-tool-count">{count}</span>
              </div>
            );
          })}
        </div>

        {scopeCounts.global + scopeCounts.project > 0 && (
          <>
            <div className="section-label">Scope</div>
            <div className="pill-row">
              <div
                className={`pill ${scopeFilter === "all" ? "active" : ""}`}
                onClick={() => setScopeFilter("all")}
                role="tab"
              >
                All
                <span className="backup-tool-count">{scopeCounts.global + scopeCounts.project}</span>
              </div>
              <div
                className={`pill ${scopeFilter === "global" ? "active" : ""} ${scopeCounts.global === 0 ? "disabled" : ""}`}
                onClick={() => scopeCounts.global > 0 && setScopeFilter("global")}
                role="tab"
              >
                Global
                <span className="backup-tool-count">{scopeCounts.global}</span>
              </div>
              <div
                className={`pill ${scopeFilter === "project" ? "active" : ""} ${scopeCounts.project === 0 ? "disabled" : ""}`}
                onClick={() => scopeCounts.project > 0 && setScopeFilter("project")}
                role="tab"
              >
                Project
                <span className="backup-tool-count">{scopeCounts.project}</span>
              </div>
            </div>
          </>
        )}
      </aside>

      {/* Pane 2: item list — mirrors RemoteList's toolbar + artifact-card layout */}
      <section className="list-pane remote-list-pane">
        <div className="list-toolbar">
          <input
            className="search"
            placeholder={
              group === "all"
                ? "Filter…"
                : group === "history"
                  ? "Filter history…"
                  : `Filter ${GROUP_LABEL[group].toLowerCase()}…`
            }
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {items.length === 0 ? (
          <div className="empty">
            {filter
              ? "No matches."
              : group === "all"
                ? "Nothing in this backup."
                : group === "history"
                  ? "No project history in this backup."
                  : `No ${GROUP_LABEL[group].toLowerCase()} backed up for this tool.`}
          </div>
        ) : (
          items.map((item) => {
            const isActive = selectedItemId === item.id;
            const description = descriptions[item.id];
            const tree = isActive ? buildFileTree(item.files) : [];
            return (
              <div key={item.id}>
                <div
                  className={`artifact-card ${isActive ? "active" : ""}`}
                  onClick={() => setSelectedItemId(isActive ? null : item.id)}
                >
                  <div className="artifact-name">
                    {item.label}
                    {item.badges.map((b) => (
                      <span key={b} className="badge">{b}</span>
                    ))}
                  </div>
                  {description && (
                    <div className="artifact-desc">{truncate(description, 160)}</div>
                  )}
                  <div className="artifact-meta backup-meta-row">
                    <span>{item.sub}</span>
                    {item.meta && (<><span>·</span><span>{item.meta}</span></>)}
                    <button
                      className="link-btn backup-open-folder"
                      onClick={(e) => {
                        e.stopPropagation();
                        const folder = bundleFolder(item.files);
                        if (folder) openExternally(folder);
                      }}
                      title="Open this item's folder in Finder/Explorer"
                    >
                      Open folder
                    </button>
                    {item.files[0]?.entry.kind === "artifact" && (
                      <button
                        className="link-btn backup-restore-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRestore(item);
                        }}
                        title="Restore this item back to its original location"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                </div>
                {isActive && tree.length > 0 && (() => {
                  const fileMap = new Map<string, BrowserFile>();
                  const attachments = toAttachments(tree, fileMap);
                  return (
                    <div className="card-tree">
                      <TreeView
                        attachments={attachments}
                        activePath={selectedFile?.destPath ?? null}
                        onOpen={(node) => {
                          if (node.isDir) return;
                          const file = fileMap.get(node.path);
                          if (file) setSelectedFile(file.entry);
                        }}
                      />
                    </div>
                  );
                })()}
              </div>
            );
          })
        )}
      </section>

      {restorePending && (
        <ConfirmDialog
          title={`Restore ${restorePending.label}`}
          message={
            <>
              <div>
                Copy this item's files back to:
              </div>
              <div className="confirm-target-path">{restoreTargetDir}</div>
              {restoreTargetExists && (
                <div className="confirm-warning">
                  ⚠ Files already exist there and will be overwritten.
                </div>
              )}
            </>
          }
          confirmLabel="Restore"
          danger={restoreTargetExists}
          busy={restoreBusy}
          onConfirm={confirmRestore}
          onCancel={() => setRestorePending(null)}
        />
      )}

      {/* Pane 3: preview — styled like RemoteEditor */}
      <section className="editor-pane remote-editor-pane">
        <div className="editor-toolbar">
          <div className="editor-title">
            {selectedFile ? fileBasename(selectedFile.relPath) : selectedItem?.label ?? "—"}
          </div>
          {selectedFile && (
            <span className="backup-editor-path" title={selectedFile.destPath}>
              {selectedItem?.label ? `${selectedItem.label} · ` : ""}
              {selectedFile.relPath}
            </span>
          )}
          {selectedFile && (
            <button onClick={() => openExternally(selectedFile.destPath)}>
              Open externally
            </button>
          )}
        </div>
        <div className="body-only">
          {!selectedFile ? (
            <div className="md-preview"><p>Select an item to preview its files.</p></div>
          ) : fileLoading ? (
            <div className="md-preview"><p>Loading…</p></div>
          ) : fileBinary ? (
            <div className="md-preview">
              <p>This file isn't text. Click <strong>Open externally</strong> to view it in the system default app.</p>
              <p style={{ color: "var(--muted)", fontSize: 12 }}>{selectedFile.destPath}</p>
            </div>
          ) : isMarkdown(selectedFile.relPath) ? (
            <div
              className="md-preview"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(fileContent ?? "") }}
            />
          ) : (
            <Monaco
              key={selectedFile.destPath}
              height="100%"
              language={inferLanguage(selectedFile.relPath)}
              theme={resolvedTheme === "light" ? "vs" : "vs-dark"}
              value={prettyForPreview(selectedFile.relPath, fileContent ?? "")}
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
    </>
  );
}

function BackupEmpty({ children }: { children?: React.ReactNode }) {
  return <div className="backup-browser-empty">{children}</div>;
}

// Combine per-tool manifests into one manifest the existing browser UI can
// render. Counts sum, entries concatenate, errors concatenate; generatedAt is
// the most recent tool's run.
function mergeToolManifests(parts: BackupManifest[], destination: string): BackupManifest {
  const counts = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  const entries: BackupEntry[] = [];
  const errors: string[] = [];
  let generatedAt = 0;
  for (const m of parts) {
    counts.added += m.counts.added;
    counts.changed += m.counts.changed;
    counts.removed += m.counts.removed;
    counts.unchanged += m.counts.unchanged;
    entries.push(...m.entries);
    errors.push(...m.errors);
    if (m.generatedAt > generatedAt) generatedAt = m.generatedAt;
  }
  return {
    version: MANIFEST_VERSION,
    generatedAt,
    destination,
    counts,
    entries,
    errors,
  };
}

// Glue layer for the Tools/Group "All" pills — fans out to the
// per-group/per-tool helpers and concatenates. Sorting matches the
// per-helper behaviour so a single-tool view and the All view list items
// in the same order.
function collectBrowserItems(
  m: BackupManifest,
  selectedTool: Tool | "all",
  group: Group | "all",
  scopeFilter: ScopeFilter,
): BrowserItem[] {
  const out: BrowserItem[] = [];
  const artifactGroups: Group[] =
    group === "all"
      ? ["skill", "agent", "command"]
      : group === "history"
        ? []
        : [group];
  const tools: Tool[] =
    selectedTool === "all" ? ALL_TOOLS.map((t) => t.id) : [selectedTool];
  for (const tool of tools) {
    for (const g of artifactGroups) {
      out.push(...groupArtifactItems(m, tool, g, scopeFilter));
    }
  }
  // History is claude-only; include when the tool filter covers claude
  // and the group filter is "all" or "history".
  const includeHistory =
    (selectedTool === "all" || selectedTool === "claude") &&
    (group === "all" || group === "history");
  if (includeHistory) out.push(...groupProjectItems(m));
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function countArtifactsByTool(m: BackupManifest | null): Partial<Record<Tool, number>> {
  if (!m) return {};
  const acc: Partial<Record<Tool, number>> = {};
  for (const e of m.entries) {
    if (e.kind !== "artifact" || !e.tool) continue;
    acc[e.tool] = (acc[e.tool] ?? 0) + 1;
  }
  return acc;
}

function groupArtifactItems(
  m: BackupManifest,
  tool: Tool,
  type: Group, // "skill" | "agent" | "command"
  scope: ScopeFilter,
): BrowserItem[] {
  const buckets = new Map<string, BrowserItem>();
  for (const e of m.entries) {
    if (e.kind !== "artifact" || e.tool !== tool) continue;
    if (e.type !== type) continue;
    if (scope !== "all" && e.scope !== scope) continue;
    const parts = e.relPath.split("/");
    const typeIdx = parts.findIndex(
      (p, i) => i > 1 && (p === "skill" || p === "agent" || p === "command"),
    );
    if (typeIdx < 0) continue;
    const rest = parts.slice(typeIdx + 1);
    let key: string;
    let label: string;
    let relInItem: string;
    if (e.type === "skill") {
      const bundle = rest[0] ?? "(unnamed)";
      key = `skill::${e.tool ?? ""}::${e.scope}::${e.projectRoot ?? ""}::${bundle}`;
      label = bundle;
      // Path *within* the bundle is everything after the bundle name.
      relInItem = rest.slice(1).join("/") || rest[0] || "";
    } else {
      const fileName = rest.join("/") || "(unnamed)";
      key = `${e.type}::${e.tool ?? ""}::${e.scope}::${e.projectRoot ?? ""}::${fileName}`;
      label = fileName;
      relInItem = fileName; // single file
    }
    let item = buckets.get(key);
    if (!item) {
      const badges = [e.type ?? "", e.scope ?? ""].filter(Boolean) as string[];
      const meta = e.scope === "project" && e.projectRoot
        ? shortProjectName(e.projectRoot)
        : undefined;
      item = { id: key, label, badges, meta, files: [] };
      buckets.set(key, item);
    }
    item.files.push({ entry: e, relInItem });
    // Pick the primary markdown file: SKILL.md for bundles, or the lone .md
    // for agent / command items.
    if (!item.primaryMdAbs) {
      const baseLower = fileBasename(e.relPath).toLowerCase();
      if (baseLower === "skill.md" || (e.type !== "skill" && baseLower.endsWith(".md"))) {
        item.primaryMdAbs = e.destPath;
      }
    }
  }
  for (const item of buckets.values()) {
    const totalBytes = item.files.reduce((sum, f) => sum + f.entry.bytes, 0);
    item.sub = `${item.files.length} file${item.files.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`;
  }
  return Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function groupProjectItems(m: BackupManifest): BrowserItem[] {
  const buckets = new Map<string, BrowserItem>();
  for (const e of m.entries) {
    if (e.kind !== "project") continue;
    const parts = e.relPath.split("/");
    // relPath = claude/history/<dirName>/<rest...>
    // (older manifests may use "projects" as the second segment — accept both.)
    const dirName = parts[2] ?? "(root)";
    const relInItem = parts.slice(3).join("/") || parts[parts.length - 1];
    let item = buckets.get(dirName);
    if (!item) {
      item = {
        id: `project::${dirName}`,
        label: dirName,
        badges: ["history"],
        meta: undefined,
        files: [],
      };
      buckets.set(dirName, item);
    }
    item.files.push({ entry: e, relInItem });
  }
  for (const item of buckets.values()) {
    const totalBytes = item.files.reduce((sum, f) => sum + f.entry.bytes, 0);
    item.sub = `${item.files.length} file${item.files.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`;
  }
  return Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label));
}

// Build a hierarchical tree from a flat list of files keyed by their rel path
// within the item. Sort directories before files at every level.
function buildFileTree(files: BrowserFile[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const f of files) {
    const parts = f.relInItem.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let cursor = root;
    let pathSoFar = "";
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${seg}` : seg;
      const isLast = i === parts.length - 1;
      let next = cursor.children.find((c) => c.name === seg);
      if (!next) {
        next = {
          name: seg,
          path: pathSoFar,
          isDir: !isLast,
          children: [],
          file: isLast ? f : undefined,
        };
        cursor.children.push(next);
      } else if (isLast) {
        next.file = f;
        next.isDir = false;
      }
      cursor = next;
    }
  }
  sortTree(root);
  return root.children;
}

function sortTree(n: FileTreeNode): void {
  n.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of n.children) if (c.isDir) sortTree(c);
}

// Best parent directory for an item's files. For multi-file bundles all
// files share a parent; for a single file we just open the file's directory.
function bundleFolder(files: BrowserFile[]): string | null {
  if (files.length === 0) return null;
  const first = files[0].entry.destPath;
  const lastSep = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
  return lastSep > 0 ? first.slice(0, lastSep) : null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// Map BackupBrowser's tree shape into TreeView's Attachment shape. For files,
// we use the entry's absolute destPath as the Attachment.path so activePath
// comparison works; the BrowserFile is also stashed in `fileMap` so the
// onOpen handler can look it up by path.
function toAttachments(nodes: FileTreeNode[], fileMap: Map<string, BrowserFile>): Attachment[] {
  return nodes.map((n) => {
    if (n.isDir) {
      return {
        name: n.name,
        path: `dir:${n.path}`,
        size: 0,
        isDir: true,
        children: toAttachments(n.children, fileMap),
      };
    }
    const file = n.file!;
    fileMap.set(file.entry.destPath, file);
    return {
      name: n.name,
      path: file.entry.destPath,
      size: file.entry.bytes,
      isDir: false,
    };
  });
}

function shortProjectName(root: string | undefined): string {
  if (!root) return "?";
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

function fileBasename(relPath: string): string {
  const parts = relPath.split("/");
  return parts[parts.length - 1] || relPath;
}

function ext(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

const MARKDOWN_EXT = new Set(["md", "mdx", "markdown"]);
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "pdf", "zip", "gz", "tgz", "tar", "7z", "exe", "dmg",
  "bin", "so", "dylib", "dll", "wasm",
  "mp3", "mp4", "mov", "wav", "ogg", "webm",
  "ttf", "otf", "woff", "woff2",
]);

function isMarkdown(name: string): boolean {
  return MARKDOWN_EXT.has(ext(fileBasename(name)));
}
function isLikelyBinary(name: string): boolean {
  return BINARY_EXT.has(ext(fileBasename(name)));
}

// Pretty-print JSON / JSONL so a one-line dump like Claude's projects history
// renders as something the user can read. Falls back to the raw text if a
// line isn't valid JSON.
function prettyForPreview(name: string, content: string): string {
  const e = ext(fileBasename(name));
  if (e === "json") {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  if (e === "jsonl" || e === "ndjson") {
    const lines = content.split(/\r?\n/);
    const out: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.stringify(JSON.parse(trimmed), null, 2));
      } catch {
        out.push(line);
      }
    }
    return out.join("\n\n");
  }
  return content;
}

function inferLanguage(name: string): string {
  const e = ext(fileBasename(name));
  const map: Record<string, string> = {
    md: "markdown", mdx: "markdown", markdown: "markdown",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    swift: "swift", c: "c", cc: "cpp", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell",
    json: "json", jsonl: "json", ndjson: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
    html: "html", htm: "html", xml: "xml", svg: "xml",
    css: "css", scss: "scss", sass: "scss",
    sql: "sql", graphql: "graphql", gql: "graphql",
    csv: "plaintext", tsv: "plaintext", txt: "plaintext", log: "plaintext",
  };
  return map[e] ?? "plaintext";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelative(ts: number): string {
  const ms = Date.now() - ts;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

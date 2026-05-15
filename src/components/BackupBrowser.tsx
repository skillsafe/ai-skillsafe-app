import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { dataTypesFor, EXTRA_SOURCES, slotForPath } from "../lib/backup/dataTypes";
import { detectPlatform, manifestPath as manifestPathOf } from "../lib/backup/appPaths";
import {
  listMasterFiles,
  loadManifest as loadMasterManifest,
  resolveMasterRoot,
  restoreSourceFromMaster,
  decodeMasterPath,
} from "../lib/master/store";
import type { MasterEntry } from "../lib/master/types";
import { resolveArtifactDir } from "../lib/paths";
import { renderMarkdown } from "../lib/markdown";
import {
  fileBasename,
  inferLanguage,
  isMarkdown,
  prettyForPreview,
} from "../lib/preview/fileClassify";
import { loadForPreview } from "../lib/preview/loader";
import { convertFileSrc } from "@tauri-apps/api/core";
import { parseFrontmatter } from "../lib/frontmatter";
import { ArchiveIcon } from "./icons";
import { TreeView } from "./TreeView";
import type { Attachment } from "../lib/artifacts/types";
import { ConfirmDialog } from "./ConfirmDialog";

// Virtual tool key used inside the BackupBrowser to surface the Workbench
// master folder alongside regular per-tool snapshots. Master is NOT a
// real backup source (the regular backup picker excludes it on purpose);
// the entry exists here so users can preview / browse master contents
// from this view too.
const MASTER_BROWSER_KEY = "master";

const ALL_TOOLS: ReadonlyArray<{ id: Tool; label: string; tooltip?: string }> = [
  ...ALL_AGENTS.map((id) => ({ id, label: displayNameOf(id) })),
  ...Object.values(EXTRA_SOURCES).map((s) => ({
    id: s.id,
    label: s.displayName,
    tooltip: s.hoverDescription,
  })),
  {
    id: MASTER_BROWSER_KEY,
    label: "Master",
    tooltip:
      "Workbench master folder — curated unified files shared across tools. Browse-only here; update via the Workbench tab.",
  },
].sort((a, b) => a.label.localeCompare(b.label));

// A "group" used to be one of the four legacy artifact types. With the new
// data-type system, the group filter mirrors whichever data-type slots
// actually exist in the current manifest — so the BackupBrowser pills match
// what the user picked in Settings.
type Group = string;
type ScopeFilter = "all" | "global" | "project";

// camelCase a slot id for `categories.*` i18n key lookup. Mirrors the
// helpers in Sidebar.tsx / CategoryBrowser.tsx / BackupPanel.tsx so the
// same translation key resolves for the same slot regardless of surface.
function slotI18nKey(slot: string): string {
  return slot.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Translates a slot id to its display label. Looks up the data-type
// registry for an English fallback (so unfamiliar slots still render
// readably) but routes through i18next so the visible label tracks the
// active locale. Mirrors the pattern used in Sidebar / CategoryBrowser /
// BackupPanel — keeping "History & Memory", "Skills", etc. consistent
// everywhere they're shown.
function slotLabelFor(slot: string, t: TFunction): string {
  let englishFallback: string | undefined;
  for (const tool of ALL_TOOLS) {
    const types = dataTypesFor(tool.id);
    const match = types.find((d) => d.id === slot);
    if (match) {
      englishFallback = match.label;
      break;
    }
  }
  if (englishFallback === undefined) {
    englishFallback = slot
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return t(`categories.${slotI18nKey(slot)}`, { defaultValue: englishFallback });
}

/** Resolves the slot id for a manifest entry. Delegates to the shared
 *  helper so summary.ts and the browser stay in sync — including the
 *  fallback that buckets stray top-level files (e.g.
 *  `~/.agents/.skill-lock.json`) under "settings" instead of treating the
 *  filename itself as a one-off slot. */
function slotOf(entry: BackupEntry): string | null {
  return slotForPath(entry.relPath);
}

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
  // Data-type slot this bucket belongs to (skills / memory / settings / …).
  // Drives folder-grouped rendering (lazy collapsed tree for memory) so the
  // render path doesn't have to re-derive it from `files[0]`.
  slot?: string;
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
  const { t } = useTranslation();
  const {
    backupDestination,
    backupLastRun,
    backupStats,
    backupBusy,
    backupProgress,
    resolvedTheme,
    setShowSettings,
    setSettingsScrollTarget,
    workbenchScanNonce,
  } = useApp();
  // Local manual-refresh tick. Bumped by the toolbar Refresh button so the
  // load effect re-runs even when nothing else has changed (e.g. the user
  // edited the master folder directly via Finder / git pull).
  const [refreshTick, setRefreshTick] = useState(0);

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
  // Preview decision for the currently selected file. Drives the right-pane
  // render branch (image | too-large | binary | text). Replaces the old
  // boolean `fileBinary` which couldn't distinguish "too large to preview"
  // from "known binary" and had no image branch at all.
  const [previewKind, setPreviewKind] = useState<
    "text" | "image" | "binary" | "too-large"
  >("text");
  const [previewSize, setPreviewSize] = useState(0);

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
        // App-folder manifest (written by summary.ts after every bash/PowerShell
        // run) is the primary source — it's tied to this machine's view and
        // doesn't depend on a cloud-synced file landing back from another
        // device. We treat it as authoritative when its `destination` matches
        // the current backup folder; mismatch ⇒ the user changed destinations
        // and the manifest is stale, so fall through to legacy locations.
        let appFolderManifest: BackupManifest | null = null;
        try {
          const home = await tauriPaths.homeDir();
          const appManifestPath = await manifestPathOf(
            detectPlatform(),
            home,
            tauriJoiner,
          );
          if (await tauriFs.exists(appManifestPath)) {
            const text = await tauriFs.readTextFile(appManifestPath);
            const m = parseManifest(text);
            if (m && m.destination === backupDestination) {
              appFolderManifest = m;
            }
          }
        } catch {
          // App-folder read is best-effort; fall back to legacy locations.
        }
        if (cancelled) return;

        // Per-tool layout: read each <dest>/<tool>_backup/LAST_BACKUP.json
        // (used by the JS-side runBackup.ts) and merge them. Falls through
        // to the legacy top-level <dest>/LAST_BACKUP.json (pre-app-folder
        // builds) when neither is present.
        const partials: BackupManifest[] = [];
        for (const tool of ALL_TOOLS) {
          const path = await tauriJoiner.join(
            backupDestination,
            toolBackupSubdir(tool.id),
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
        // Master folder entries are added to whichever manifest we end up
        // returning so the user can browse/preview master files alongside
        // regular tool snapshots. The master folder itself isn't a backup
        // source — the entries are read live from <backup>/master/.
        const masterResult = await loadMasterAsBackupEntries(
          backupDestination,
          null,
        );
        const masterEntries = masterResult.entries;
        if (masterResult.error) {
          // Don't block the rest of the manifest; just toast the failure so
          // the user knows their master folder is misconfigured rather than
          // silently empty.
          onToast(
            "error",
            t("backupBrowser.errors.masterLoadFailed", { message: masterResult.error }),
          );
        }
        if (cancelled) return;

        let baseManifest: BackupManifest | null = appFolderManifest;
        if (!baseManifest && partials.length > 0) {
          baseManifest = mergeToolManifests(partials, backupDestination);
        }
        if (!baseManifest) {
          // Fallback: pre-app-folder builds wrote the single manifest into
          // <dest>/LAST_BACKUP.json (and an even older layout into
          // <dest>/skillsafe-backup/LAST_BACKUP.json). Keep reading from
          // these so existing installs aren't blank on first launch of the
          // new build; the next "Back up now" run rewrites to the app
          // folder and the legacy file becomes inert (the walker still
          // skips it via summary.ts SKIP_FILES).
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
            baseManifest = parseManifest(text);
            if (!baseManifest) setLoadError(t("backupBrowser.manifestUnreadable"));
          }
        }

        if (baseManifest) {
          // Defensive: drop any pre-existing tool="master" entries from
          // older manifests (which may have used the legacy <tool>--<name>
          // filename layout that no longer exists on disk). The fresh
          // masterEntries are authoritative.
          baseManifest.entries = baseManifest.entries.filter(
            (e) => e.kind !== "artifact" || e.tool !== MASTER_BROWSER_KEY,
          );
          baseManifest.entries.push(...masterEntries);
          setManifest(baseManifest);
          return;
        }

        // No regular backup yet — render master-only if we have it,
        // otherwise an empty manifest so the panel shows its empty state.
        if (masterEntries.length > 0) {
          setManifest({
            version: MANIFEST_VERSION,
            generatedAt: 0,
            destination: backupDestination,
            counts: { added: 0, changed: 0, removed: 0, unchanged: 0 },
            entries: masterEntries,
            errors: [],
          });
          return;
        }
        setManifest(null);
      } catch (e) {
        if (cancelled) return;
        setManifest(null);
        setLoadError(
          e instanceof Error
            ? t("backupBrowser.manifestReadFailed", { message: e.message })
            : t("backupBrowser.manifestReadFailedShort"),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [backupDestination, backupLastRun, workbenchScanNonce, refreshTick]);

  const toolCounts = useMemo(() => countArtifactsByTool(manifest), [manifest]);

  // Tool pills only render when the user has actually backed something up for
  // that tool. The "All" pill is always available so the user can browse
  // across tools.
  const visibleTools = useMemo(
    () => ALL_TOOLS.filter((tool) => (toolCounts[tool.id] ?? 0) > 0),
    [toolCounts],
  );
  const totalToolItems = useMemo(
    () => visibleTools.reduce((n, tool) => n + (toolCounts[tool.id] ?? 0), 0),
    [visibleTools, toolCounts],
  );

  // Dynamically derive the set of group pills from the manifest itself —
  // the slots present (skills, plugins, memory, settings, …) match the
  // data-types the user picked in Settings, no hardcoded list.
  const groupCounts = useMemo(() => {
    const acc = new Map<string, number>();
    if (!manifest) return acc;
    for (const e of manifest.entries) {
      if (e.kind !== "artifact") continue;
      if (selectedTool !== "all" && e.tool !== selectedTool) continue;
      const slot = slotOf(e);
      if (!slot) continue;
      acc.set(slot, (acc.get(slot) ?? 0) + 1);
    }
    return acc;
  }, [manifest, selectedTool]);

  const groupOrder = useMemo(() => {
    // Stable, predictable ordering: skills first (highest-signal), then the
    // rest alphabetized by display label.
    const slots = Array.from(groupCounts.keys());
    slots.sort((a, b) => {
      if (a === "skills") return -1;
      if (b === "skills") return 1;
      return slotLabelFor(a, t).localeCompare(slotLabelFor(b, t));
    });
    return slots;
  }, [groupCounts, t]);

  const totalGroupItems = useMemo(() => {
    let n = 0;
    for (const v of groupCounts.values()) n += v;
    return n;
  }, [groupCounts]);

  // Within the selected tool+group, which scopes are present? History
  // entries have no scope, so they're naturally excluded; the Scope row
  // hides itself when no scoped artifacts are visible.
  const scopeCounts = useMemo(() => {
    const acc: Record<"global" | "project", number> = { global: 0, project: 0 };
    if (!manifest) return acc;
    for (const e of manifest.entries) {
      if (e.kind !== "artifact") continue;
      if (selectedTool !== "all" && e.tool !== selectedTool) continue;
      if (group !== "all" && slotOf(e) !== group) continue;
      if (e.scope === "global") acc.global += 1;
      else if (e.scope === "project") acc.project += 1;
    }
    return acc;
  }, [manifest, selectedTool, group]);

  const [filter, setFilter] = useState("");

  const items: BrowserItem[] = useMemo(() => {
    if (!manifest) return [];
    const base = collectBrowserItems(manifest, selectedTool, group, scopeFilter, t);
    const q = filter.toLowerCase().trim();
    if (!q) return base;
    return base.filter((i) =>
      i.label.toLowerCase().includes(q) ||
      (i.sub ?? "").toLowerCase().includes(q),
    );
  }, [manifest, group, selectedTool, scopeFilter, filter, t]);

  // History & Memory dedicated view: one big collapsible tree mirroring the
  // in-app CategoryBrowser instead of a flat list of per-file rows. Built
  // from the manifest entries themselves so no disk walk is needed; the
  // tree opens with all folders collapsed so a project with hundreds of
  // transcripts doesn't blow out the pane.
  const memoryView = useMemo(() => {
    if (group !== "memory") return null;
    if (!manifest) return { attachments: [], fileMap: new Map<string, BackupEntry>(), description: "" };
    const q = filter.toLowerCase().trim();
    const matching: BackupEntry[] = [];
    for (const e of manifest.entries) {
      if (e.kind !== "artifact") continue;
      if (selectedTool !== "all" && e.tool !== selectedTool) continue;
      if (scopeFilter !== "all" && e.scope !== scopeFilter) continue;
      if (slotOf(e) !== "memory") continue;
      matching.push(e);
    }
    const { tree, fileMap } = buildMemoryTree(matching);
    const attachments = memoryTreeToAttachments(tree, fileMap);
    const filtered = q ? filterAttachmentTree(attachments, q) : attachments;
    // Description: prefer the active tool's; fall back to claude's "memory"
    // entry; finally a generic note. The in-app CategoryBrowser uses the
    // DataType's own description verbatim.
    const dataType =
      (selectedTool !== "all" ? dataTypesFor(selectedTool).find((dt) => dt.id === "memory") : null) ??
      dataTypesFor("claude").find((dt) => dt.id === "memory") ??
      null;
    return { attachments: filtered, fileMap, description: dataType?.description ?? "" };
  }, [group, manifest, selectedTool, scopeFilter, filter]);

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
    if ((groupCounts.get(group) ?? 0) > 0) return;
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

  // Load selected file's content for preview. Goes through the shared
  // loadForPreview helper so the BackupBrowser, AttachmentTree and remote
  // trees all agree on which files render inline, which fall back to
  // "Open externally", and which are too large to attempt at all.
  useEffect(() => {
    let cancelled = false;
    async function loadFile() {
      if (!selectedFile) {
        setFileContent(null);
        setPreviewKind("text");
        setPreviewSize(0);
        return;
      }
      setFileLoading(true);
      try {
        const result = await loadForPreview(
          tauriFs,
          selectedFile.destPath,
          fileBasename(selectedFile.relPath),
        );
        if (cancelled) return;
        setPreviewKind(result.kind);
        setPreviewSize(result.kind === "text" || result.kind === "binary" || result.kind === "too-large" ? result.size : 0);
        setFileContent(result.kind === "text" ? result.content : null);
      } catch (e) {
        if (cancelled) return;
        setPreviewKind("text");
        setFileContent(
          t("backupBrowser.errors.readFileFailed", {
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    }
    loadFile();
    return () => {
      cancelled = true;
    };
  }, [selectedFile, t]);

  async function openExternally(destPath: string) {
    try {
      await shellOpen(destPath);
    } catch (e) {
      onToast("error", t("backupBrowser.errors.openFailed", { message: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function startRestore(item: BrowserItem) {
    const firstEntry = item.files[0]?.entry;
    if (!firstEntry || firstEntry.kind !== "artifact") return;
    // Master items go through a separate flow: the destination is the
    // entry's first recorded source on disk, not a registry-resolved
    // tool config dir.
    if (firstEntry.tool === MASTER_BROWSER_KEY) {
      try {
        const masterRel = firstEntry.relPath.replace(/^master\//, "");
        const root = await resolveMasterRoot(
          tauriPaths,
          null,
          backupDestination ?? null,
        );
        const m = await loadMasterManifest(tauriFs, tauriJoiner, root);
        const entry = m.entries.find((e) => e.masterPath === masterRel);
        const source = entry?.sources[0];
        if (!entry || !source) {
          onToast("error", t("backupBrowser.errors.masterNoSource"));
          return;
        }
        setRestoreTargetDir(source.absPath);
        setRestoreTargetExists(await tauriFs.exists(source.absPath));
        setRestorePending(item);
      } catch (e) {
        onToast("error", t("backupBrowser.errors.masterPrepareFailed", { message: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (!firstEntry.tool || !firstEntry.scope || !firstEntry.type) {
      onToast("error", t("backupBrowser.errors.missingFields"));
      return;
    }
    if (firstEntry.scope === "project" && !firstEntry.projectRoot) {
      onToast("error", t("backupBrowser.errors.missingProjectRoot"));
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
      onToast("error", t("backupBrowser.errors.resolveTargetFailed", { message: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function confirmRestore() {
    const item = restorePending;
    if (!item) return;
    const firstEntry = item.files[0]?.entry;
    if (!firstEntry || firstEntry.kind !== "artifact") {
      setRestorePending(null);
      return;
    }
    // Master items: write the master payload back to its first recorded
    // source via the Workbench's restore helper, which knows how to merge
    // MCP entries (and overwrite memory files).
    if (firstEntry.tool === MASTER_BROWSER_KEY) {
      setRestoreBusy(true);
      try {
        const masterRel = firstEntry.relPath.replace(/^master\//, "");
        const root = await resolveMasterRoot(
          tauriPaths,
          null,
          backupDestination ?? null,
        );
        const m = await loadMasterManifest(tauriFs, tauriJoiner, root);
        const entry = m.entries.find((e) => e.masterPath === masterRel);
        const source = entry?.sources[0];
        if (!entry || !source) {
          onToast("error", t("backupBrowser.errors.masterMissing"));
          return;
        }
        await restoreSourceFromMaster(tauriFs, tauriJoiner, root, entry, source, item.label);
        onToast("ok", t("backupBrowser.ok.restoredMaster", { path: source.absPath }));
        setRestorePending(null);
      } catch (e) {
        onToast("error", t("backupBrowser.errors.restoreFailed", { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setRestoreBusy(false);
      }
      return;
    }
    if (!firstEntry.tool || !firstEntry.scope || !firstEntry.type) {
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
        t("backupBrowser.ok.restoredFiles", { copied: result.written.length, dir: result.targetDir }),
      );
      setRestorePending(null);
    } catch (e) {
      onToast("error", t("backupBrowser.errors.restoreFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRestoreBusy(false);
    }
  }

  // Empty states (mirror cloud panel's empty state styling).
  // No destination → useEffect above auto-opens Settings. Render an empty
  // shell so the panel area isn't a flash of "set things up here" copy.
  if (!backupDestination) return <BackupEmpty />;
  if (loading && !manifest) return <BackupEmpty>{t("backupBrowser.loadingManifest")}</BackupEmpty>;
  if (!manifest) {
    return (
      <BackupEmpty>
        <div className="backup-empty-title">
          {loadError ?? t("backupBrowser.noBackupYet")}
        </div>
        <div
          className="backup-empty-action"
          dangerouslySetInnerHTML={{ __html: t("backupBrowser.emptyAction") }}
        />
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
          <div className="brand-title">{t("backupBrowser.title")}</div>
        </div>

        <div className="settings-row" style={{ paddingLeft: 6 }}>
          <button
            className="primary"
            onClick={openBackupSettings}
            disabled={backupBusy}
            title={
              backupBusy
                ? t("backupBrowser.backupBusyTitle")
                : t("backupBrowser.configureBackupTitle")
            }
          >
            {backupBusy ? t("backupBrowser.backingUp") : t("backupBrowser.configureBackup")}
          </button>
        </div>

        <div className="section-label">{t("backupBrowser.tools")}</div>
        <div className="pill-row" style={{ flexWrap: "wrap" }}>
          {visibleTools.length === 0 ? (
            <div className="empty" style={{ padding: 0 }}>
              {t("backupBrowser.nothingBackedUp")}
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
                title={t("backupBrowser.allTooltip", { count: totalToolItems })}
              >
                {t("backupBrowser.all")}
                <span className="backup-tool-count">{totalToolItems}</span>
              </div>
              {visibleTools.map((tool) => {
                const count = toolCounts[tool.id] ?? 0;
                const label =
                  tool.id === MASTER_BROWSER_KEY ? t("backupBrowser.masterLabel") : tool.label;
                const tooltip =
                  tool.id === MASTER_BROWSER_KEY ? t("backupBrowser.masterTooltip") : tool.tooltip;
                return (
                  <div
                    key={tool.id}
                    className={`pill ${selectedTool === tool.id ? "active" : ""}`}
                    onClick={() => setSelectedTool(tool.id)}
                    role="tab"
                    aria-selected={selectedTool === tool.id}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        setSelectedTool(tool.id);
                      }
                    }}
                    title={
                      tooltip
                        ? t("backupBrowser.toolTooltipDesc", { tooltip, count })
                        : t("backupBrowser.toolTooltip", { label, count })
                    }
                  >
                    {label}
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
              {t("backupBrowser.progressLabel", {
                phase: backupProgress.phase,
                filesProcessed: backupProgress.filesProcessed,
                bytesProcessed: formatBytes(backupProgress.bytesProcessed, t),
                filesCopied: backupProgress.filesCopied,
                bytesCopied: formatBytes(backupProgress.bytesCopied, t),
              })}
            </div>
          </div>
        )}

        <div className="backup-last-run">
          {backupLastRun && backupStats
            ? t("backupBrowser.lastBackupLine", {
                relative: formatRelative(backupLastRun, t),
                added: backupStats.counts.added,
                changed: backupStats.counts.changed,
                removed: backupStats.counts.removed,
                bytes: formatBytes(backupStats.totalBytes, t),
              })
            : t("backupBrowser.neverBackedUp")}
        </div>

        <div className="section-label">{t("backupBrowser.group")}</div>
        <div className="pill-row" style={{ flexWrap: "wrap" }}>
          <div
            className={`pill ${group === "all" ? "active" : ""}`}
            onClick={() => setGroup("all")}
            role="tab"
            aria-selected={group === "all"}
          >
            {t("backupBrowser.all")}
            <span className="backup-tool-count">{totalGroupItems}</span>
          </div>
          {groupOrder.map((g) => {
            const count = groupCounts.get(g) ?? 0;
            const enabled = count > 0;
            return (
              <div
                key={g}
                className={`pill ${group === g ? "active" : ""} ${enabled ? "" : "disabled"}`}
                onClick={() => enabled && setGroup(g)}
                role="tab"
                aria-selected={group === g}
              >
                {slotLabelFor(g, t)}
                <span className="backup-tool-count">{count}</span>
              </div>
            );
          })}
        </div>

        {scopeCounts.global + scopeCounts.project > 0 && (
          <>
            <div className="section-label">{t("backupBrowser.scope")}</div>
            <div className="pill-row">
              <div
                className={`pill ${scopeFilter === "all" ? "active" : ""}`}
                onClick={() => setScopeFilter("all")}
                role="tab"
              >
                {t("backupBrowser.all")}
                <span className="backup-tool-count">{scopeCounts.global + scopeCounts.project}</span>
              </div>
              <div
                className={`pill ${scopeFilter === "global" ? "active" : ""} ${scopeCounts.global === 0 ? "disabled" : ""}`}
                onClick={() => scopeCounts.global > 0 && setScopeFilter("global")}
                role="tab"
              >
                {t("backupBrowser.global")}
                <span className="backup-tool-count">{scopeCounts.global}</span>
              </div>
              <div
                className={`pill ${scopeFilter === "project" ? "active" : ""} ${scopeCounts.project === 0 ? "disabled" : ""}`}
                onClick={() => scopeCounts.project > 0 && setScopeFilter("project")}
                role="tab"
              >
                {t("backupBrowser.project")}
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
                ? t("backupBrowser.filterPlaceholder")
                : group === "history"
                  ? t("backupBrowser.filterHistoryPlaceholder")
                  : t("backupBrowser.filterSlotPlaceholder", { slot: slotLabelFor(group, t).toLowerCase() })
            }
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            onClick={() => setRefreshTick((n) => n + 1)}
            disabled={loading}
            aria-label={t("backupBrowser.reloadAria")}
            title={
              loading
                ? t("backupBrowser.reloading")
                : t("backupBrowser.reloadTitle")
            }
            data-testid="backup-browser-refresh"
          >
            ↻
          </button>
        </div>
        {memoryView ? (
          <>
            {/* CategoryBrowser-style header above the unified tree so the
                Local Backup view matches the in-app History & Memory layout
                pixel-for-pixel: label, optional description, then a single
                collapsible tree of project / global folders. */}
            <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontWeight: 600 }}>{slotLabelFor("memory", t)}</div>
              {memoryView.description && (
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                  {t("categories.memoryDesc", { defaultValue: memoryView.description })}
                </div>
              )}
            </div>
            {memoryView.attachments.length === 0 ? (
              <div className="empty">
                {filter ? t("backupBrowser.noMatches") : t("backupBrowser.noHistory")}
              </div>
            ) : (
              <div style={{ padding: "8px 4px" }}>
                <TreeView
                  attachments={memoryView.attachments}
                  activePath={selectedFile?.destPath ?? null}
                  defaultExpanded={false}
                  showHeader={false}
                  onOpen={(node) => {
                    if (node.isDir) return;
                    const entry = memoryView.fileMap.get(node.path);
                    if (entry) setSelectedFile(entry);
                  }}
                />
              </div>
            )}
          </>
        ) : items.length === 0 ? (
          <div className="empty">
            {filter
              ? t("backupBrowser.noMatches")
              : group === "all"
                ? t("backupBrowser.nothingInBackup")
                : group === "history"
                  ? t("backupBrowser.noHistory")
                  : t("backupBrowser.noSlotForTool", { slot: slotLabelFor(group, t).toLowerCase() })}
          </div>
        ) : (
          items.map((item) => {
            const isActive = selectedItemId === item.id;
            const description = descriptions[item.id];
            const isFolderGrouped = item.slot
              ? FOLDER_GROUPED_SLOTS.has(item.slot)
              : false;
            // Memory aggregate rows rebuild a CategoryBrowser-shaped tree
            // (projects/ flattened, global hoisted) so the card matches the
            // dedicated memory view. Everything else uses the literal
            // relInItem layout.
            const tree = isActive
              ? isFolderGrouped
                ? buildMemoryTree(item.files.map((f) => f.entry)).tree
                : buildFileTree(item.files)
              : [];
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
                      title={t("backupBrowser.openFolderTitle")}
                    >
                      {t("backupBrowser.openFolder")}
                    </button>
                    {item.files[0]?.entry.kind === "artifact" && (
                      <button
                        className="link-btn backup-restore-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRestore(item);
                        }}
                        title={t("backupBrowser.restoreBtnTitle")}
                      >
                        {t("backupBrowser.restoreBtn")}
                      </button>
                    )}
                  </div>
                </div>
                {/* Skip the inline tree for single-file items — the only
                    file is auto-selected on click and shown in the preview
                    pane, so a one-row tree is dead weight. Folder-grouped
                    slots (memory) render with collapsed folders by default
                    so a project with hundreds of transcripts doesn't blow
                    out the card; the user expands what they want, matching
                    the in-app CategoryBrowser behavior. */}
                {isActive && item.files.length > 1 && tree.length > 0 && (() => {
                  const fileMap = new Map<string, BrowserFile>();
                  const attachments = toAttachments(tree, fileMap);
                  return (
                    <div className="card-tree">
                      <TreeView
                        attachments={attachments}
                        activePath={selectedFile?.destPath ?? null}
                        defaultExpanded={!isFolderGrouped}
                        showHeader={!isFolderGrouped}
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
          title={t("backupBrowser.restoreDialogTitle", { label: restorePending.label })}
          message={
            <>
              <div>{t("backupBrowser.restoreDialogIntro")}</div>
              <div className="confirm-target-path">{restoreTargetDir}</div>
              {restoreTargetExists && (
                <div className="confirm-warning">
                  {t("backupBrowser.restoreWarn")}
                </div>
              )}
            </>
          }
          confirmLabel={t("backupBrowser.restoreConfirm")}
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
              {t("backupBrowser.openExternally")}
            </button>
          )}
        </div>
        <div className="body-only">
          {!selectedFile ? (
            <div className="md-preview"><p>{t("backupBrowser.selectToPreview")}</p></div>
          ) : fileLoading ? (
            <div className="md-preview"><p>{t("backupBrowser.loading")}</p></div>
          ) : previewKind === "image" ? (
            <div className="md-preview" style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: 12 }}>
              <img
                src={convertFileSrc(selectedFile.destPath)}
                alt={fileBasename(selectedFile.relPath)}
                style={{ maxWidth: "100%", maxHeight: "100%" }}
              />
            </div>
          ) : previewKind === "too-large" ? (
            <div className="md-preview">
              <p>{t("backupBrowser.tooLargeHint", { mb: (previewSize / (1024 * 1024)).toFixed(1) })}</p>
              <p style={{ color: "var(--muted)", fontSize: 12 }}>{selectedFile.destPath}</p>
            </div>
          ) : previewKind === "binary" ? (
            <div className="md-preview">
              <p dangerouslySetInnerHTML={{ __html: t("backupBrowser.binaryHint") }} />
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

// Synthesize backup-shaped entries for every file in the Workbench
// master folder. Returned entries are tagged with tool="master" so the
// existing tool-tile / counts / preview pipeline picks them up; they are
// NOT real backup snapshots — the destPath is the live master file
// itself, and Restore is intercepted to call the Workbench's master
// restore path instead of the regular backup restore.
async function loadMasterAsBackupEntries(
  backupDestination: string,
  masterRootOverride: string | null,
): Promise<{ entries: BackupEntry[]; error: string | null }> {
  try {
    const masterRoot = await resolveMasterRoot(
      tauriPaths,
      masterRootOverride,
      backupDestination,
    );
    if (!(await tauriFs.exists(masterRoot))) return { entries: [], error: null };
    const [rawFiles, manifest] = await Promise.all([
      listMasterFiles(tauriFs, tauriJoiner, masterRoot),
      loadMasterManifest(tauriFs, tauriJoiner, masterRoot),
    ]);
    // Defensive: listMasterFiles already skips manifest.json at every
    // depth, but older bundled builds shipped without that skip and we
    // never want metadata showing up as a "Restore"-able row in the
    // BackupBrowser. Drop any path whose basename is the master manifest.
    const files = rawFiles.filter((rel) => {
      const base = rel.split("/").pop() ?? rel;
      return base.toLowerCase() !== "manifest.json";
    });
    if (files.length === 0) return { entries: [], error: null };
    const byPath = new Map<string, MasterEntry>();
    for (const e of manifest.entries) byPath.set(e.masterPath, e);
    // Parallelize stat() so a master folder with hundreds of files doesn't
    // spend O(n × roundtrip) sequentially just to read sizes.
    const out: BackupEntry[] = await Promise.all(
      files.map(async (rel) => {
        const abs = await tauriJoiner.join(masterRoot, ...rel.split("/"));
        let bytes = 0;
        try {
          bytes = (await tauriFs.stat(abs)).size;
        } catch {
          /* ignore */
        }
        const entry = byPath.get(rel);
        const decoded = decodeMasterPath(rel);
        // Prefix the relPath with "master/" so slotForPath can decide a
        // sensible slot; unknown segments fall through to "settings". We
        // also expose the underlying source's tool/scope when known so the
        // file tree headers read naturally.
        return {
          kind: "artifact",
          tool: MASTER_BROWSER_KEY,
          scope:
            entry?.sources[0]?.scope ?? decoded.scope ?? "global",
          // "agent" is the closest existing artifact type for memory-style
          // single-file content. Restore is intercepted before this is
          // used to resolve a target dir.
          type: "agent",
          projectRoot: entry?.sources[0]?.projectPath ?? undefined,
          relPath: `master/${rel}`,
          destPath: abs,
          sha256: entry?.canonicalHash ?? "",
          bytes,
          status: "unchanged",
        };
      }),
    );
    return { entries: out, error: null };
  } catch (e) {
    // Surface the failure to the caller so a misconfigured master folder
    // doesn't silently look like an empty one. Master is still optional —
    // the caller decides whether to toast or just render zero rows.
    return {
      entries: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
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

// Builds the items to render in the middle pane. Filters apply at the entry
// level (tool / slot / scope) and bucketing is slot-aware: the "skills" slot
// groups files into bundles by directory; every other slot lists each file
// as its own item.
function collectBrowserItems(
  m: BackupManifest,
  selectedTool: Tool | "all",
  group: Group | "all",
  scopeFilter: ScopeFilter,
  t: TFunction,
): BrowserItem[] {
  const out: BrowserItem[] = [];
  const tools: Tool[] =
    selectedTool === "all" ? ALL_TOOLS.map((x) => x.id) : [selectedTool];
  for (const tool of tools) {
    out.push(...itemsForTool(m, tool, group, scopeFilter, t));
  }
  // Legacy project-kind entries (from the older runBackup-based manifest)
  // are still rendered as "history" items for backwards compatibility.
  const includeHistory =
    (selectedTool === "all" || selectedTool === "claude") &&
    (group === "all" || group === "history");
  if (includeHistory) out.push(...groupProjectItems(m, t));
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

// Slots that contain skill bundles (a directory with SKILL.md + assets) —
// items in these slots are grouped one bucket per top-level subdirectory.
// Everything else gets one bucket per file so the middle-pane list is
// browsable without click-into-bundle navigation.
const BUNDLE_SLOTS = new Set(["skills"]);

// Slots that should be presented as collapsible per-folder buckets instead
// of one row per file. History & Memory mirrors the in-app CategoryBrowser
// here: one row per project (or global / conversations / …), each
// expanding into a lazy tree of its files. Listing every transcript as a
// separate row drowns the middle pane on real backups.
const FOLDER_GROUPED_SLOTS = new Set(["memory"]);

function itemsForTool(
  m: BackupManifest,
  tool: Tool,
  group: Group | "all",
  scope: ScopeFilter,
  t: TFunction,
): BrowserItem[] {
  const buckets = new Map<string, BrowserItem>();
  for (const e of m.entries) {
    if (e.kind !== "artifact" || e.tool !== tool) continue;
    if (scope !== "all" && e.scope !== scope) continue;
    const slot = slotOf(e);
    if (!slot) continue;
    if (group !== "all" && slot !== group) continue;

    const parts = e.relPath.split("/");
    // When the slot was matched against parts[1] (a real data-type dir),
    // skip both segments. When the slot came from the "settings" fallback
    // (a stray top-level file like `~/.agents/.skill-lock.json`), parts[1]
    // *is* the file — keep it.
    const slotIsLiteralDir = parts[1] === slot;
    const rest = slotIsLiteralDir ? parts.slice(2) : parts.slice(1);

    let key: string;
    let label: string;
    let relInItem: string;
    // Folder-grouped slots (memory) collapse into a single aggregate row
    // per tool so the All view shows "History & Memory" once instead of
    // hundreds of per-transcript rows. The card body unpacks the aggregate
    // back into a CategoryBrowser-style tree (see card-tree rendering).
    const isAggregateSlot = FOLDER_GROUPED_SLOTS.has(slot);
    if (BUNDLE_SLOTS.has(slot)) {
      const bundle = rest[0] ?? t("backupBrowser.unnamed");
      key = `${slot}::${tool}::${e.scope ?? ""}::${e.projectRoot ?? ""}::${bundle}`;
      label = bundle;
      relInItem = rest.slice(1).join("/") || rest[0] || "";
    } else if (isAggregateSlot) {
      key = `${slot}::${tool}::__aggregate__`;
      label = slotLabelFor(slot, t);
      // Preserve the full sub-slot path so buildMemoryTree can rebuild the
      // project / global folder structure inside the card-tree.
      relInItem = rest.join("/") || slot;
    } else {
      const fileName = rest.join("/") || t("backupBrowser.unnamed");
      key = `${slot}::${tool}::${e.scope ?? ""}::${e.projectRoot ?? ""}::${fileName}`;
      label = fileName;
      relInItem = fileName;
    }

    let item = buckets.get(key);
    if (!item) {
      const slotBadge = slotLabelFor(slot, t).toLowerCase();
      // Aggregate rows may span scopes (global + per-project memory in
      // one card), so skip the scope badge/meta — they'd be misleading.
      const badges = isAggregateSlot
        ? [slotBadge]
        : ([slotBadge, e.scope ?? ""].filter(Boolean) as string[]);
      const meta = isAggregateSlot
        ? undefined
        : e.scope === "project" && e.projectRoot
          ? shortProjectName(e.projectRoot)
          : undefined;
      item = { id: key, label, badges, meta, files: [], slot };
      buckets.set(key, item);
    }
    item.files.push({ entry: e, relInItem });
    if (!item.primaryMdAbs) {
      const baseLower = fileBasename(e.relPath).toLowerCase();
      if (baseLower === "skill.md" || (!BUNDLE_SLOTS.has(slot) && baseLower.endsWith(".md"))) {
        item.primaryMdAbs = e.destPath;
      }
    }
  }
  for (const item of buckets.values()) {
    const totalBytes = item.files.reduce((sum, f) => sum + f.entry.bytes, 0);
    item.sub = t("backupBrowser.fileSummary", {
      count: item.files.length,
      bytes: formatBytes(totalBytes, t),
    });
  }
  return Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function groupProjectItems(m: BackupManifest, t: TFunction): BrowserItem[] {
  const buckets = new Map<string, BrowserItem>();
  for (const e of m.entries) {
    if (e.kind !== "project") continue;
    const parts = e.relPath.split("/");
    // relPath = claude/history/<dirName>/<rest...>
    // (older manifests may use "projects" as the second segment — accept both.)
    const dirName = parts[2] ?? t("backupBrowser.rootFolder");
    const relInItem = parts.slice(3).join("/") || parts[parts.length - 1];
    let item = buckets.get(dirName);
    if (!item) {
      item = {
        id: `project::${dirName}`,
        label: dirName,
        badges: [t("backupBrowser.historyBadge")],
        meta: undefined,
        files: [],
      };
      buckets.set(dirName, item);
    }
    item.files.push({ entry: e, relInItem });
  }
  for (const item of buckets.values()) {
    const totalBytes = item.files.reduce((sum, f) => sum + f.entry.bytes, 0);
    item.sub = t("backupBrowser.fileSummary", {
      count: item.files.length,
      bytes: formatBytes(totalBytes, t),
    });
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

/**
 * Build a single unified tree from every memory-slot backup entry. Mirrors
 * CategoryBrowser's "flatten projects/" behavior so per-project history
 * dirs surface as top-level nodes instead of hiding under a "projects"
 * wrapper. `fileMap` keys by the file's destPath so the tree's onOpen can
 * resolve back to the originating BackupEntry.
 */
function buildMemoryTree(entries: ReadonlyArray<BackupEntry>): {
  tree: FileTreeNode[];
  fileMap: Map<string, BackupEntry>;
} {
  const root: FileTreeNode = { name: "", path: "", isDir: true, children: [] };
  const fileMap = new Map<string, BackupEntry>();
  for (const e of entries) {
    if (e.kind !== "artifact") continue;
    const parts = e.relPath.split("/").filter(Boolean);
    // parts[0]=<tool>, parts[1]="memory" (slot). When the slot prefix is
    // missing for some reason, fall back to skipping just the tool.
    const restAll = parts[1] === "memory" ? parts.slice(2) : parts.slice(1);
    if (restAll.length === 0) continue;
    // CategoryBrowser flattens the projects/ wrapper one level so each
    // project root shows up as its own top-level row. Do the same here.
    const rest = restAll[0] === "projects" && restAll.length >= 2
      ? restAll.slice(1)
      : restAll;
    let cursor = root;
    let pathSoFar = "";
    for (let i = 0; i < rest.length; i++) {
      const seg = rest[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${seg}` : seg;
      const isLast = i === rest.length - 1;
      let next = cursor.children.find((c) => c.name === seg);
      if (!next) {
        next = {
          name: seg,
          path: pathSoFar,
          isDir: !isLast,
          children: [],
          file: isLast ? { entry: e, relInItem: rest.join("/") } : undefined,
        };
        cursor.children.push(next);
      } else if (isLast) {
        next.file = { entry: e, relInItem: rest.join("/") };
        next.isDir = false;
      }
      cursor = next;
    }
    fileMap.set(e.destPath, e);
  }
  sortTree(root);
  return { tree: root.children, fileMap };
}

/**
 * Convert the internal FileTreeNode shape into TreeView's Attachment shape.
 * Files use the BackupEntry's destPath as the Attachment.path so activePath
 * comparison and fileMap lookup line up; folders use a `dir:` prefix to
 * avoid collisions with file paths.
 */
function memoryTreeToAttachments(
  nodes: FileTreeNode[],
  _fileMap: Map<string, BackupEntry>,
): Attachment[] {
  return nodes.map((n) => {
    if (n.isDir) {
      return {
        name: n.name,
        path: `dir:${n.path}`,
        size: 0,
        isDir: true,
        children: memoryTreeToAttachments(n.children, _fileMap),
      };
    }
    const file = n.file!;
    return {
      name: n.name,
      path: file.entry.destPath,
      size: file.entry.bytes,
      isDir: false,
    };
  });
}

/** Recursive name-substring filter that keeps a folder when any descendant
 *  matches. Used for the memory view's search box. */
function filterAttachmentTree(nodes: Attachment[], q: string): Attachment[] {
  const out: Attachment[] = [];
  for (const n of nodes) {
    if (n.isDir) {
      const kids = filterAttachmentTree(n.children ?? [], q);
      if (kids.length > 0 || n.name.toLowerCase().includes(q)) {
        out.push({ ...n, children: kids });
      }
    } else if (n.name.toLowerCase().includes(q)) {
      out.push(n);
    }
  }
  return out;
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

function formatBytes(n: number, t: TFunction): string {
  if (n < 1024) return t("backupPanel.bytes.b", { n });
  if (n < 1024 * 1024) return t("backupPanel.bytes.kb", { n: (n / 1024).toFixed(1) });
  if (n < 1024 * 1024 * 1024) return t("backupPanel.bytes.mb", { n: (n / 1024 / 1024).toFixed(1) });
  return t("backupPanel.bytes.gb", { n: (n / 1024 / 1024 / 1024).toFixed(2) });
}

function formatRelative(ts: number, t: TFunction): string {
  const ms = Date.now() - ts;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t("backupPanel.relative.justNow");
  if (minutes < 60) return t("backupPanel.relative.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("backupPanel.relative.hours", { count: hours });
  const days = Math.floor(hours / 24);
  return t("backupPanel.relative.days", { count: days });
}

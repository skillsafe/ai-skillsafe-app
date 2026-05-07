import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sidebar } from "./components/Sidebar";
import { ArtifactList } from "./components/ArtifactList";
import { Editor } from "./components/Editor";
import { HistoryPanel } from "./components/HistoryPanel";
import { DiffViewOverlay } from "./components/DiffViewOverlay";
import { NewArtifactDialog } from "./components/NewArtifactDialog";
import { ConvertDialog } from "./components/ConvertDialog";
import { CloudInfoPane } from "./components/CloudInfoPane";
import { RemoteList } from "./components/RemoteList";
import { RemoteEditor } from "./components/RemoteEditor";
import { CloudActionsDialog } from "./components/CloudActionsDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { BackupBrowser } from "./components/BackupBrowser";
import type { ArtifactType, MarkdownArtifact, Scope, Tool } from "./lib/artifacts/types";
import { useApp } from "./lib/store";
import { listArtifacts } from "./lib/tools";
import { tauriFs, tauriJoiner, tauriPaths } from "./lib/tauriAdapters";
import { createSkillBundle, deleteSkillBundle } from "./lib/artifacts/skill";
import { createMarkdownFile, deleteMarkdownFile } from "./lib/artifacts/markdownFile";
import { resolveArtifactDir } from "./lib/paths";
import { computeBundleHash, readLockfile } from "./lib/lockfile";
import { convertArtifact } from "./lib/convert";
import { stringifyFrontmatter } from "./lib/frontmatter";
import { atomicWrite, ensureDir } from "./lib/fs";
import { resolveDeletePreview, type DeletePreview } from "./lib/artifacts/deletePreview";
import { backupOneArtifact } from "./lib/backup/single";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ResizeHandle } from "./components/ResizeHandle";
import { searchSkills, listAccountSkills, getSkill, SkillSafeError } from "./lib/skillsafe/client";
import { fetchAccount } from "./lib/skillsafe/auth";
import { cloudSkillToArtifact } from "./lib/skillsafe/asArtifact";
import { installSkill } from "./lib/skillsafe/install";
import { UpdateBanner } from "./components/UpdateBanner";
import { UpdateDialog } from "./components/UpdateDialog";
import * as updateRunner from "./lib/update/runner";
import { createOrchestrator } from "./lib/update/orchestrator";
import { InstallScopeDialog, type InstallScopeChoice } from "./components/InstallScopeDialog";
import { parseDeepLink, type DeepLinkInstall } from "./lib/deepLink";
import { getCurrent as getCurrentDeepLinks, onOpenUrl } from "@tauri-apps/plugin-deep-link";

export default function App() {
  const {
    tool,
    scope,
    type,
    projectRoot,
    recentProjects,
    projectFilter,
    artifacts,
    selectedId,
    setArtifacts,
    setSelectedId,
    setLoading,
    setError,
    setDrift,
    error,
    theme,
    resolvedTheme,
    setResolvedTheme,
    cloudOpen,
    bottomPanel,
    toggleCloudOpen,
    setBottomPanel,
    setTool,
    cloudApiKey,
    cloudAccount,
    setCloudAuth,
    remoteFilter,
    remoteQuery,
    remoteSort,
    setRemoteArtifacts,
    appendRemoteArtifacts,
    setRemoteLoading,
    setRemoteError,
    setRemoteHasMore,
    setRemoteNextCursor,
    setRemoteLoadingMore,
    remoteNextCursor,
    remoteHasMore,
    remoteLoadingMore,
    showSettings,
    setShowSettings,
    backupDestination,
    setBackupResult,
    removeArtifact,
    layout,
    setLayout,
    showUpdateDialog,
    setDismissedUpdateVersion,
    currentVersion,
  } = useApp();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  // Window title carries the running version so users can verify which
  // build they're on without opening Settings. Static "title" in
  // tauri.conf.json is the at-launch fallback; this overrides it once
  // React mounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        await getCurrentWindow().setTitle(`AI SkillSafe v${currentVersion}`);
      } catch {
        // Non-Tauri context (e.g. vitest) — nothing to do.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentVersion]);

  // When theme === "system", track OS preference changes live.
  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => setResolvedTheme(mql.matches ? "light" : "dark");
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, [theme, setResolvedTheme]);

  const [showNew, setShowNew] = useState(false);
  const [showConvert, setShowConvert] = useState(false);
  const [showCloudActions, setShowCloudActions] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const orchestrator = useMemo(() => {
    const store = useApp.getState();
    return createOrchestrator({
      runner: updateRunner,
      store: {
        getAutoUpdate: () => useApp.getState().autoUpdate,
        getDismissedVersion: () => useApp.getState().dismissedUpdateVersion,
        setAvailableUpdate: store.setAvailableUpdate,
        setUpdateProgress: store.setUpdateProgress,
        setUpdateError: store.setUpdateError,
        setUpdateReadyToInstall: store.setUpdateReadyToInstall,
        setShowUpdateDialog: store.setShowUpdateDialog,
      },
    });
  }, []);

  // Update-check schedule: 5s after mount + every 6h. The orchestrator
  // attaches its own install-on-quit hook only after a download completes,
  // so the window's normal close button keeps working when nothing's pending.
  useEffect(() => {
    const startTimer = setTimeout(() => {
      orchestrator.runUpdateCycle().catch((e) => console.error("update cycle:", e));
    }, 5000);
    const interval = setInterval(() => {
      orchestrator.runUpdateCycle().catch((e) => console.error("update cycle:", e));
    }, 6 * 60 * 60 * 1000);

    return () => {
      clearTimeout(startTimer);
      clearInterval(interval);
    };
  }, [orchestrator]);

  // Deep-link entry: runtime URLs come via `onOpenUrl` (the typed wrapper
  // that subscribes to the deep-link plugin's `deep-link://new-url` event on
  // every platform), and `getCurrent` (cold-start URL the OS launched us
  // with). We previously also called `listen("deep-link://new-url")` as a
  // belt-and-braces second subscription, but that combined with single-
  // instance's `deep-link` feature reentered Tauri's event dispatch and stack-
  // overflowed on every URL delivery — see crash report 263178F1 (v0.2.1).
  useEffect(() => {
    let cancelled = false;
    const handleUrl = (raw: string) => {
      if (cancelled) return;
      const parsed = parseDeepLink(raw);
      if (!parsed) return;
      if (parsed.tool) setTool(parsed.tool);
      setBottomPanel("cloud");
      setDeepLinkInstall(parsed);
    };
    const handleUrls = (urls: string[] | null | undefined) => {
      if (!urls) return;
      for (const u of urls) handleUrl(u);
    };

    const unlisteners: Array<() => void> = [];
    (async () => {
      try {
        const current = await getCurrentDeepLinks();
        handleUrls(current);
      } catch (e) {
        console.warn("[deep-link] getCurrent failed:", e);
      }
      try {
        const off = await onOpenUrl((urls: string[]) => handleUrls(urls));
        unlisteners.push(off);
      } catch (e) {
        console.warn("[deep-link] onOpenUrl failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      for (const off of unlisteners) {
        try { off(); } catch { /* ignore */ }
      }
    };
  }, [setBottomPanel, setTool]);
  // Per-row action state.
  const [uploadPresetId, setUploadPresetId] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<MarkdownArtifact | null>(null);
  // Cascade preview: resolved asynchronously after pendingDelete is set so
  // the confirmation dialog can show *exactly* which paths the delete will
  // touch (the bundle, an associated bridge symlink, both, or just the link).
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [backingUpId, setBackingUpId] = useState<string | null>(null);

  // Deep-link install: when a `skillsafe://install?ns=…&name=…&version=…&tool=…`
  // URL fires (cold-start, runtime, or via single-instance forwarding), we
  // open the scope-picker dialog so the user confirms global vs. project
  // before any files are written. This is the entry point used by the
  // "Open in SkillSafe app" button on skillsafe.ai.
  const [deepLinkInstall, setDeepLinkInstall] = useState<DeepLinkInstall | null>(null);
  const [deepLinkBusy, setDeepLinkBusy] = useState(false);

  // emitToast must be stable across renders — RemoteEditor includes it in a
  // useEffect dep array, so a fresh closure every render would re-trigger
  // manifest fetches and loop on 404s.
  // Error toasts persist (so the user can copy the message for debugging);
  // success toasts auto-dismiss.
  const emitToast = useCallback((kind: "ok" | "error", text: string) => {
    setToast({ kind, text });
    if (kind === "ok") setTimeout(() => setToast(null), 3000);
    // Mirror error toasts onto a CustomEvent so the dev-only ui-driver can
    // capture user-visible failures into its error ring buffer. The
    // listener is registered by inject.js, which is only loaded when
    // UI_DRIVER=1; in production the event has no listener and is a no-op.
    if (kind === "error" && import.meta.env.DEV) {
      window.dispatchEvent(
        new CustomEvent("skillsafe:driver-error", {
          detail: { source: "toast", message: text },
        }),
      );
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fan "all" sentinels out into the concrete scopes/types the loader
      // accepts. Scope=all spans global + every project; type=all spans the
      // three artifact kinds.
      const concreteScopes: Array<"global" | "project" | "lockfile"> =
        scope === "all" ? ["global", "project"] : [scope];
      const concreteTypes: Array<"skill" | "agent" | "command"> =
        type === "all" ? ["skill", "agent", "command"] : [type];

      const aggregated: MarkdownArtifact[] = [];
      const seen = new Set<string>();

      for (const sc of concreteScopes) {
        for (const ty of concreteTypes) {
          // Project + lockfile aggregate across every saved project root,
          // unless the user has narrowed the view to a single one via the
          // sidebar's project-filter dropdown.
          if ((sc === "project" || sc === "lockfile") && recentProjects.length > 0) {
            const roots =
              projectFilter && recentProjects.includes(projectFilter)
                ? [projectFilter]
                : recentProjects;
            for (const root of roots) {
              try {
                const sub = await listArtifacts(tauriFs, tauriJoiner, tauriPaths, {
                  tool, scope: sc, type: ty, projectRoot: root,
                });
                for (const a of sub) {
                  const key = `${root}::${a.id}`;
                  if (seen.has(key)) continue;
                  seen.add(key);
                  aggregated.push({ ...a, id: key });
                }
              } catch (err) { console.warn("[reload] project listArtifacts failed:", err); }
            }
          } else {
            try {
              const sub = await listArtifacts(tauriFs, tauriJoiner, tauriPaths, {
                tool, scope: sc, type: ty, projectRoot: projectRoot ?? undefined,
              });
              for (const a of sub) {
                if (seen.has(a.id)) continue;
                seen.add(a.id);
                aggregated.push(a);
              }
            } catch (err) { console.warn("[reload] listArtifacts failed:", { tool, scope: sc, type: ty }, err); }
          }
        }
      }

      setArtifacts(aggregated);
      if (scope === "lockfile" && projectRoot) {
        await refreshDrift(aggregated, projectRoot);
      } else {
        setDrift({});
      }
    } catch (e) {
      setError(String(e));
      setArtifacts([]);
    } finally {
      setLoading(false);
    }
  }, [tool, scope, type, projectRoot, recentProjects, projectFilter, setArtifacts, setLoading, setError, setDrift]);

  async function refreshDrift(list: MarkdownArtifact[], root: string) {
    const lockPath = await tauriJoiner.join(root, "skills-lock.json");
    const lock = await readLockfile(tauriFs, lockPath);
    if (!lock) {
      setDrift({});
      return;
    }
    const drift: Record<string, boolean> = {};
    for (const a of list) {
      const expected = lock.skills[a.name]?.computedHash;
      if (!expected) continue;
      const actual = a.bundleDir
        ? await computeBundleHash(tauriFs, tauriJoiner, a.bundleDir)
        : a.computedHash ?? "";
      drift[a.name] = actual !== expected;
    }
    setDrift(drift);
  }

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-fetch account once we have a key but no account record yet. If the
  // key is bad we *must* surface that — otherwise the Mine filter sits in
  // "Loading…" forever while the user wonders why their skills are missing.
  useEffect(() => {
    if (!cloudApiKey || cloudAccount) return;
    let cancelled = false;
    fetchAccount(cloudApiKey)
      .then((a) => { if (!cancelled) setCloudAuth(cloudApiKey, a); })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof SkillSafeError ? `${e.code}: ${e.message}` : String(e);
        emitToast("error", `Cloud sign-in expired or invalid: ${msg}. Sign in again from settings.`);
        setCloudAuth(null, null);
      });
    return () => { cancelled = true; };
  }, [cloudApiKey, cloudAccount, setCloudAuth]);

  // Generation counter, not AbortController: each reloadRemote bumps the gen
  // and, after every await, discards results whose gen no longer matches the
  // latest. Avoids @tauri-apps/plugin-http's leaked unhandledrejection from
  // its abort path (fetch_cancel against an already-consumed request rid
  // rejects with "The resource id N is invalid"). The in-flight fetch still
  // completes server-side; we just ignore its result.
  const remoteGenRef = useRef(0);
  const reloadRemote = useCallback(async () => {
    if (!cloudOpen) return;
    const isOwnerView =
      remoteFilter === "all" || remoteFilter === "private" || remoteFilter === "shared";
    // If the auth handshake is still resolving, hold off on the owner-view
    // call so the public fallback doesn't overwrite the eventual result.
    if (cloudApiKey && !cloudAccount && isOwnerView) {
      remoteGenRef.current += 1;
      setRemoteArtifacts([]);
      setRemoteLoading(true);
      return;
    }
    const effectiveFilter = cloudApiKey && cloudAccount ? remoteFilter : "public";
    const myGen = ++remoteGenRef.current;
    const isStale = () => myGen !== remoteGenRef.current;
    // Clear the previous filter's results immediately so the user sees a
    // Loading state instead of e.g. public skills bleeding into the Private
    // tab while /v1/account/skills is in flight.
    setRemoteArtifacts([]);
    setRemoteLoading(true);
    setRemoteError(null);
    setRemoteHasMore(false);
    setRemoteNextCursor(null);
    try {
      let data;
      const isShared = (s: { visibility?: string; active_share_count?: number | string }) =>
        s.visibility === "public" ||
        (typeof s.active_share_count === "number"
          ? s.active_share_count > 0
          : Number(s.active_share_count) > 0);
      const q = remoteQuery.trim().toLowerCase();
      const matchesQuery = (s: { name: string; description?: string | null }) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q);

      if (effectiveFilter === "all" && cloudApiKey) {
        // "All" = private + shared (from /v1/account/skills) followed by top
        // public results (from /v1/skills/search), ordered private → shared →
        // public. The two endpoints can overlap on the user's own public
        // skills, so dedupe by skill_id.
        const [accountRes, publicRes] = await Promise.all([
          listAccountSkills(cloudApiKey),
          searchSkills({ q: remoteQuery || undefined, sort: remoteSort, limit: 20 }),
        ]);
        if (isStale()) return;
        const account = accountRes.data.filter(matchesQuery);
        const privateSkills = account.filter((s) => !isShared(s));
        const sharedSkills = account.filter(isShared);
        const seen = new Set(account.map((s) => s.skill_id));
        const publicSkills = publicRes.data.filter((s) => !seen.has(s.skill_id));
        data = [...privateSkills, ...sharedSkills, ...publicSkills];
        const meta = publicRes.meta;
        setRemoteHasMore(!!meta?.pagination?.has_more);
        setRemoteNextCursor(meta?.pagination?.next_cursor ?? null);
      } else if (
        (effectiveFilter === "private" || effectiveFilter === "shared") &&
        cloudApiKey
      ) {
        // /v1/skills/search hides the user's private skills even when
        // authed; the owner-only listing comes from /v1/account/skills.
        // Private vs Shared partitions it by visibility + active_share_count,
        // mirroring the website's dashboard filter.
        const res = await listAccountSkills(cloudApiKey);
        if (isStale()) return;
        data = res.data.filter((s) => (effectiveFilter === "shared" ? isShared(s) : !isShared(s)));
        data = data.filter(matchesQuery);
      } else {
        const res = await searchSkills({ q: remoteQuery || undefined, sort: remoteSort, limit: 20 });
        if (isStale()) return;
        data = res.data;
        const meta = res.meta;
        setRemoteHasMore(!!meta?.pagination?.has_more);
        setRemoteNextCursor(meta?.pagination?.next_cursor ?? null);
      }
      setRemoteArtifacts(data.map(cloudSkillToArtifact));
    } catch (e) {
      if (isStale()) return;
      const msg = e instanceof SkillSafeError ? `${e.code}: ${e.message}` : String(e);
      setRemoteError(msg);
      setRemoteArtifacts([]);
    } finally {
      if (!isStale()) setRemoteLoading(false);
    }
  }, [
    cloudOpen,
    cloudApiKey,
    cloudAccount,
    remoteFilter,
    remoteQuery,
    remoteSort,
    setRemoteArtifacts,
    setRemoteLoading,
    setRemoteError,
    setRemoteHasMore,
    setRemoteNextCursor,
  ]);

  // Append the next page of public results when the user scrolls near the
  // bottom of the remote list. Private/Shared come back in one shot from
  // /v1/account/skills so they have no "more" state. "All" pages the public
  // tail since the account skills are already fully loaded above it.
  const loadMoreRemote = useCallback(async () => {
    if (!remoteHasMore || !remoteNextCursor || remoteLoadingMore) return;
    if (remoteFilter !== "public" && remoteFilter !== "all") return;
    setRemoteLoadingMore(true);
    try {
      const res = await searchSkills({
        q: remoteQuery || undefined,
        sort: remoteSort,
        limit: 20,
        cursor: remoteNextCursor,
      });
      appendRemoteArtifacts(res.data.map(cloudSkillToArtifact));
      setRemoteHasMore(!!res.meta?.pagination?.has_more);
      setRemoteNextCursor(res.meta?.pagination?.next_cursor ?? null);
    } catch (e) {
      const msg = e instanceof SkillSafeError ? `${e.code}: ${e.message}` : String(e);
      emitToast("error", `Couldn't load more skills: ${msg}`);
    } finally {
      setRemoteLoadingMore(false);
    }
  }, [
    remoteHasMore,
    remoteNextCursor,
    remoteLoadingMore,
    remoteFilter,
    remoteQuery,
    remoteSort,
    appendRemoteArtifacts,
    setRemoteHasMore,
    setRemoteNextCursor,
    setRemoteLoadingMore,
    emitToast,
  ]);

  // Reload remote on relevant changes (filter, sort, account, open).
  useEffect(() => {
    if (!cloudOpen) return;
    reloadRemote();
  }, [cloudOpen, remoteFilter, remoteSort, cloudAccount, reloadRemote]);

  const confirmDeepLinkInstall = useCallback(
    async (choice: InstallScopeChoice) => {
      const intent = deepLinkInstall;
      if (!intent) return;
      setDeepLinkBusy(true);
      try {
        // Resolve the version: deep link may omit it ("install latest"),
        // in which case we look it up via /v1/skills/<ns>/<name>.
        let version = intent.version;
        if (!version) {
          const meta = await getSkill(intent.ns, intent.name, cloudApiKey);
          version = meta.data.latest_version;
          if (!version) {
            throw new Error(`Skill ${intent.ns}/${intent.name} has no published version yet.`);
          }
        }
        const result = await installSkill(tauriFs, tauriPaths, tauriJoiner, {
          apiKey: cloudApiKey,
          ns: intent.ns,
          name: intent.name,
          version,
          tool: choice.tool,
          scope: choice.scope,
          projectRoot: choice.scope === "project" ? choice.projectRoot : undefined,
          useSymlink: choice.useSymlink,
        });
        emitToast(
          "ok",
          `Installed ${intent.ns}/${intent.name}@${version} → ${result.targetDir}`,
        );
        setDeepLinkInstall(null);
        await reload();
        if (cloudOpen) await reloadRemote();
      } catch (e) {
        const msg =
          e instanceof SkillSafeError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        emitToast("error", `Install failed: ${msg}`);
      } finally {
        setDeepLinkBusy(false);
      }
    },
    [deepLinkInstall, cloudApiKey, tool, emitToast, reload, reloadRemote, cloudOpen],
  );

  useEffect(() => {
    if (!error) return;
    // Errors persist until dismissed so they can be read/copied for debugging.
    setToast({ kind: "error", text: error });
  }, [error]);

  // Resolve the delete-preview (cascade paths + symlink-vs-real) for the
  // pending artifact. Runs once each time the user opens the modal so the
  // copy can spell out exactly what will be removed.
  useEffect(() => {
    if (!pendingDelete) {
      setDeletePreview(null);
      return;
    }
    let cancelled = false;
    resolveDeletePreview(tauriFs, tauriJoiner, pendingDelete).then((p) => {
      if (!cancelled) setDeletePreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [pendingDelete]);

  const selected = artifacts.find((a) => a.id === selectedId) ?? null;

  async function handleCreate(name: string, description: string) {
    // "all" is a UI sentinel only; coerce before writing files.
    const effScope = scope === "all" ? "global" : scope;
    const effType = type === "all" ? "skill" : type;
    const dir = await targetDir(tool, effScope, effType, projectRoot);
    try {
      const newArtifact =
        effType === "skill"
          ? await createSkillBundle(tauriFs, tauriJoiner, dir, name, description, tool, effScope)
          : await createMarkdownFile(
              tauriFs,
              tauriJoiner,
              dir,
              `${name}.md`,
              { name, description },
              `# ${name}\n\n${description}\n`,
              tool,
              effScope,
              effType,
            );
      setShowNew(false);
      await reload();
      setSelectedId(newArtifact.id);
      setToast({ kind: "ok", text: "Created." });
      setTimeout(() => setToast(null), 2500);
    } catch (e) {
      setToast({ kind: "error", text: `Create failed: ${e}` });
    }
  }

  // Aggregated artifacts have synthetic ids prefixed `${projectRoot}::` so
  // multiple project roots can coexist in one list. Reverse it to find which
  // project an artifact came from when we need projectRoot for backup/etc.
  function projectRootForArtifact(a: MarkdownArtifact): string | undefined {
    const idx = a.id.indexOf("::");
    if (idx > 0) return a.id.slice(0, idx);
    if (a.scope === "project" || a.scope === "lockfile") return projectRoot ?? undefined;
    return undefined;
  }

  function handleUploadFromRow(a: MarkdownArtifact) {
    setUploadPresetId(a.id);
    setShowCloudActions(true);
  }

  async function handleBackupFromRow(a: MarkdownArtifact) {
    if (!backupDestination) {
      emitToast("error", "Set a backup folder in Settings → Local Backup first.");
      return;
    }
    setBackingUpId(a.id);
    try {
      const stats = await backupOneArtifact({
        fs: tauriFs,
        paths: tauriPaths,
        joiner: tauriJoiner,
        destination: backupDestination,
        artifact: a,
        projectRoot: projectRootForArtifact(a),
      });
      setBackupResult(stats.generatedAt, stats);
      const { added, changed, unchanged } = stats.counts;
      const wrote = added + changed;
      if (wrote === 0) {
        emitToast("ok", `${a.name}: already up to date (${unchanged} files unchanged).`);
      } else {
        emitToast("ok", `Backed up ${a.name}: +${added} ~${changed}.`);
      }
    } catch (e) {
      emitToast("error", `Backup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBackingUpId(null);
    }
  }

  async function confirmDelete() {
    const a = pendingDelete;
    if (!a) return;
    setDeleteBusy(true);
    try {
      if (a.isBundle) {
        await deleteSkillBundle(tauriFs, a);
      } else {
        await deleteMarkdownFile(tauriFs, a);
      }
      removeArtifact(a.id);
      emitToast("ok", `Deleted ${a.name}.`);
      setPendingDelete(null);
      await reload();
    } catch (e) {
      emitToast("error", `Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleConvert(targetTool: Tool, targetType: ArtifactType) {
    if (!selected) return;
    try {
      const effTargetType = targetType === "all" ? "skill" : targetType;
      const effScope = scope === "all" ? "global" : scope;
      const converted = convertArtifact(selected, { targetTool, targetType: effTargetType });
      const dir = await targetDir(targetTool, effScope, effTargetType, projectRoot);
      await ensureDir(tauriFs, dir);
      const filePath = converted.isBundle
        ? await tauriJoiner.join(dir, selected.name, converted.fileName)
        : await tauriJoiner.join(dir, converted.fileName);
      if (converted.isBundle) {
        await ensureDir(tauriFs, await tauriJoiner.join(dir, selected.name));
      }
      const raw = stringifyFrontmatter(converted.frontmatter, converted.body);
      await atomicWrite(tauriFs, filePath, raw);
      setShowConvert(false);
      setToast({ kind: "ok", text: `Converted → ${filePath}` });
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setToast({ kind: "error", text: `Convert failed: ${e}` });
    }
  }

  const handleRestartNow = useCallback(async () => {
    try {
      await orchestrator.installPendingNow((p) => useApp.getState().setUpdateProgress(p));
    } catch (e) {
      emitToast("error", `Install failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      useApp.getState().setUpdateProgress(null);
    }
  }, [orchestrator, emitToast]);

  return (
    <div className="app-root">
      <UpdateBanner onRestartNow={handleRestartNow} />
    <div
      className={`app ${bottomPanel ? "bottom-open" : ""}`}
      style={{
        // CSS variables drive grid-template sizes (see styles.css `.app`).
        // Updating them on every drag tick is cheap because grid recomputes
        // layout without re-rendering React subtrees.
        ["--col1" as string]: `${layout.col1}px`,
        ["--col2" as string]: `${layout.col2}px`,
        ["--row1" as string]: `${layout.rowPct}%`,
      }}>
      <Sidebar
        onToggleCloud={toggleCloudOpen}
        onToggleBackup={() => setBottomPanel(bottomPanel === "backup" ? null : "backup")}
        onOpenSettings={() => setShowSettings(true)}
      />
      <ArtifactList
        onNew={() => setShowNew(true)}
        onConvert={() => setShowConvert(true)}
        onReload={reload}
        onDelete={(a) => setPendingDelete(a)}
        onBackup={(a) => {
          if (backingUpId) return;
          handleBackupFromRow(a);
        }}
        onUpload={handleUploadFromRow}
      />
      <Editor artifact={selected} onReload={reload} />
      <HistoryPanel onReload={reload} />
      <DiffViewOverlay />

      {bottomPanel === "cloud" && (
        <>
          <CloudInfoPane
            onToast={emitToast}
            onReload={reloadRemote}
            onOpenActions={() => setShowCloudActions(true)}
          />
          <RemoteList
            onToast={emitToast}
            onAfterInstall={reload}
            onLoadMore={loadMoreRemote}
            onAfterMutation={reloadRemote}
          />
          <RemoteEditor onToast={emitToast} />
        </>
      )}

      {bottomPanel === "backup" && <BackupBrowser onToast={emitToast} />}

      {/* Column resize handles. Positioned at the gridline between
          sidebar↔list-pane and list-pane↔editor-pane respectively. */}
      <ResizeHandle
        axis="col"
        value={layout.col1}
        min={160}
        max={480}
        style={{ left: `${layout.col1}px` }}
        ariaLabel="Resize sidebar"
        onChange={(v) => setLayout({ col1: v })}
      />
      <ResizeHandle
        axis="col"
        value={layout.col2}
        min={200}
        max={560}
        style={{ left: `calc(${layout.col1}px + ${layout.col2}px)` }}
        ariaLabel="Resize artifact list"
        onChange={(v) => setLayout({ col2: v })}
      />
      {bottomPanel && (
        <ResizeHandle
          axis="row"
          value={layout.rowPct}
          min={18}
          max={82}
          style={{ top: `${layout.rowPct}%` }}
          ariaLabel="Resize bottom panel"
          onChange={(v) => setLayout({ rowPct: v })}
        />
      )}

      {showNew && (
        <NewArtifactDialog onCancel={() => setShowNew(false)} onCreate={handleCreate} />
      )}
      {showConvert && selected && (
        <ConvertDialog
          source={selected}
          onCancel={() => setShowConvert(false)}
          onConvert={handleConvert}
        />
      )}
      {showCloudActions && (
        <CloudActionsDialog
          onClose={() => {
            setShowCloudActions(false);
            setUploadPresetId(undefined);
          }}
          onToast={emitToast}
          presetArtifactId={uploadPresetId}
          onAfterSave={reloadRemote}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.name}?`}
          message={renderDeleteMessage(pendingDelete, deletePreview)}
          confirmLabel="Delete"
          danger
          busy={deleteBusy}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {showSettings && (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          onToast={emitToast}
        />
      )}
      {deepLinkInstall && (
        <InstallScopeDialog
          artifactName={deepLinkInstall.name}
          tool={deepLinkInstall.tool ?? tool}
          recentProjects={recentProjects}
          defaultScope={projectRoot ? "project" : "global"}
          defaultProjectRoot={projectRoot ?? undefined}
          busy={deepLinkBusy}
          onConfirm={confirmDeepLinkInstall}
          onCancel={() => {
            if (deepLinkBusy) return;
            setDeepLinkInstall(null);
          }}
        />
      )}
      {toast && (
        <div className={`toast ${toast.kind}`}>
          <span className="toast-text">{toast.text}</span>
          {toast.kind === "error" && (
            <button
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => setToast(null)}
            >
              ×
            </button>
          )}
        </div>
      )}
      {showUpdateDialog && (
        <UpdateDialog
          onAccept={async () => {
            try {
              await orchestrator.acceptPromptedUpdate((p) => useApp.getState().setUpdateProgress(p));
            } catch (e) {
              useApp.getState().setUpdateError(e instanceof Error ? e.message : String(e));
            }
          }}
          onLater={() => orchestrator.dismissPromptedUpdate(false, () => {})}
          onSkip={() => orchestrator.dismissPromptedUpdate(true, setDismissedUpdateVersion)}
        />
      )}
    </div>
    </div>
  );
}

function renderDeleteMessage(
  artifact: MarkdownArtifact,
  preview: DeletePreview | null,
): ReactNode {
  // No preview yet — keep the dialog responsive while the cascade resolver
  // runs. The single-path fallback matches the conservative behavior even
  // if the user hits "Delete" before the resolver returns.
  if (!preview) {
    return (
      <>
        <div>
          This will remove the {artifact.isBundle ? "skill bundle" : "file"} from disk:
        </div>
        <div className="confirm-target-path">{artifact.bundleDir ?? artifact.path}</div>
      </>
    );
  }

  // Case 3: bundleDir is itself a symlink. `deleteSkillBundle` unlinks the
  // link only — the underlying bundle that the link points to is left in
  // place. The copy spells this out so the user isn't surprised.
  if (preview.primaryIsSymlink) {
    return (
      <>
        <div>This entry is a symlink. Deleting it will only remove the link:</div>
        <div className="confirm-target-path">{preview.primaryPath}</div>
        <div className="confirm-note">
          The underlying skill bundle that this symlink points to will <strong>not</strong> be removed.
        </div>
      </>
    );
  }

  // Case 2: bundle + bridge symlink. Both paths get removed together so
  // the user knows about the cascade before they confirm.
  if (preview.bridgeSymlinkPath) {
    return (
      <>
        <div>This will remove <strong>2 paths</strong> from disk:</div>
        <ol className="confirm-path-list">
          <li>
            <span className="confirm-path-label">Skill bundle:</span>
            <div className="confirm-target-path">{preview.primaryPath}</div>
          </li>
          <li>
            <span className="confirm-path-label">Symlink for Claude Code:</span>
            <div className="confirm-target-path">{preview.bridgeSymlinkPath}</div>
          </li>
        </ol>
      </>
    );
  }

  // Case 1: a single real bundle/file, no cascade.
  return (
    <>
      <div>
        This will remove the {artifact.isBundle ? "skill bundle" : "file"} from disk:
      </div>
      <div className="confirm-target-path">{preview.primaryPath}</div>
    </>
  );
}

async function targetDir(
  tool: Tool,
  scope: Exclude<Scope, "all">,
  type: Exclude<ArtifactType, "all">,
  projectRoot: string | null,
): Promise<string> {
  // Claude is the one tool whose project-scope skill writes still go under
  // .agents/skills (the cross-tool universal location), not .claude/skills,
  // to match how `npx skills add claude-code …` lays things out alongside
  // every other agent that shares the universal location. Everything else
  // (skill/agent/command) routes through the registry-driven resolver.
  if (tool === "claude" && scope === "project" && projectRoot) {
    const sub = type === "skill" ? "skills" : type === "agent" ? "agents" : "commands";
    return tauriJoiner.join(projectRoot, ".agents", sub);
  }
  return resolveArtifactDir(
    tauriPaths,
    tool,
    scope === "lockfile" ? "project" : scope,
    type,
    projectRoot ?? undefined,
  );
}

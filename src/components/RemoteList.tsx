import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { installSkill } from "../lib/skillsafe/install";
import { InstallBlockedError, type ShieldVerdict } from "../lib/skillsafe/shield";
import { getTauriFeedClient } from "../lib/feeds/tauri";
import { QuarantineDialog } from "./QuarantineDialog";
import {
  deleteSkill,
  setCurrentVersion,
  SkillSafeError,
  starSkill,
  unstarSkill,
  yankSkillVersion,
} from "../lib/skillsafe/client";
import { RemoteAttachmentTree } from "./RemoteAttachmentTree";
import { findSkillMdPath } from "../lib/skillsafe/asArtifact";
import type { DownloadManifestFile } from "../lib/skillsafe/types";
import { InstallScopeDialog, type InstallScopeChoice } from "./InstallScopeDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { RemoteRowMenu, type RemoteRowMenuItem } from "./RemoteRowMenu";
import { ShareLinksDialog } from "./ShareLinksDialog";
import { VersionActionDialog, type VersionAction } from "./VersionActionDialog";

interface Props {
  onToast: (kind: "ok" | "error", text: string) => void;
  onAfterInstall: () => Promise<void> | void;
  onLoadMore: () => Promise<void> | void;
  // Fired after a destructive action (delete, yank, set-current) so the host
  // can re-fetch the cloud listing and version cache.
  onAfterMutation?: () => Promise<void> | void;
  // Re-fetch the cloud listing. Wired to the toolbar's Refresh button so
  // users can force a reload without changing filter/sort.
  onReload?: () => Promise<void> | void;
}

export function RemoteList({
  onToast,
  onAfterInstall,
  onLoadMore,
  onAfterMutation,
  onReload,
}: Props) {
  const { t } = useTranslation();
  const {
    remoteArtifacts,
    remoteSelectedId,
    setRemoteSelectedId,
    remoteLoading,
    remoteError,
    remoteBodyCache,
    remotePathToHash,
    remoteSelectedVersion,
    remoteHasMore,
    remoteLoadingMore,
    artifacts,
    cloudApiKey,
    cloudAccount,
    tool,
    scope,
    projectRoot,
    recentProjects,
    installedRemoteIds,
    markRemoteInstalled,
  } = useApp();
  const [filter, setFilter] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  // Pending install: when set, shows the scope-picker dialog. The actual
  // download starts once the user confirms.
  const [pendingInstallId, setPendingInstallId] = useState<string | null>(null);

  // Per-action pending state. We track artifact ids (not version) so the
  // current row can show busy/spinner state in its menu trigger.
  const [busyId, setBusyId] = useState<string | null>(null);
  // Optimistic star tracking — the API doesn't surface is_starred on listing
  // results, so we only know about stars the user toggled this session.
  const [starredIds, setStarredIds] = useState<Set<string>>(() => new Set());

  // Dialog state.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingShareId, setPendingShareId] = useState<string | null>(null);
  const [pendingVersionActionId, setPendingVersionActionId] = useState<string | null>(null);
  const [pendingVersionActionKind, setPendingVersionActionKind] = useState<VersionAction>("set-current");
  // Shield: opens when a remote install is rejected by the rule feed.
  const [blockedInstall, setBlockedInstall] = useState<{
    skillName: string;
    verdict: Extract<ShieldVerdict, { kind: "block" }>;
  } | null>(null);

  const sectionRef = useRef<HTMLElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => { onLoadMoreRef.current = onLoadMore; }, [onLoadMore]);

  // Auto-paginate when the user scrolls within ~120px of the bottom of the
  // list pane. We use a scroll listener (not IntersectionObserver) because
  // the latter is finicky when the scroll root is itself a flex/grid child;
  // a plain pixel comparison is reliable.
  useEffect(() => {
    if (!remoteHasMore) return;
    const el = sectionRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
        onLoadMoreRef.current();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [remoteHasMore]);

  const localNames = useMemo(
    () => new Set(artifacts.map((a) => a.name)),
    [artifacts],
  );

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return remoteArtifacts;
    return remoteArtifacts.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        String(a.frontmatter.description ?? "").toLowerCase().includes(q),
    );
  }, [remoteArtifacts, filter]);

  // Ownership: server flags `is_owner` on /v1/account/skills, but for skills
  // returned from /skills/search the field is absent. Fall back to comparing
  // the artifact's namespace against the signed-in account's.
  function isOwnerOf(a: typeof remoteArtifacts[number]): boolean {
    if (a.frontmatter.is_owner === true) return true;
    if (!cloudAccount?.namespace) return false;
    const ns = String(a.frontmatter.namespace ?? "");
    return ns === cloudAccount.namespace;
  }

  function startInstall(id: string) {
    setPendingInstallId(id);
  }

  async function confirmInstall(choice: InstallScopeChoice) {
    const id = pendingInstallId;
    if (!id) return;
    const a = remoteArtifacts.find((r) => r.id === id);
    if (!a) return;
    const ns = a.frontmatter.namespace as string | undefined;
    const version = a.frontmatter.version as string | undefined;
    if (!ns || !version) {
      onToast("error", t("remoteList.missingMeta"));
      setPendingInstallId(null);
      return;
    }
    setInstalling(id);
    try {
      const result = await installSkill(tauriFs, tauriPaths, tauriJoiner, {
        apiKey: cloudApiKey,
        ns,
        name: a.name,
        version,
        // The dialog defaults to the sidebar's selected agent but the user
        // can override it inline before confirming.
        tool: choice.tool,
        scope: choice.scope,
        projectRoot: choice.scope === "project" ? choice.projectRoot : undefined,
        shield: {
          fs: tauriFs,
          pj: tauriJoiner,
          feed: getTauriFeedClient(),
        },
      });
      if (result.shieldVerdict?.kind === "quarantine") {
        onToast(
          "error",
          t("remoteList.quarantinedToast", {
            ns,
            name: a.name,
            reason: result.shieldVerdict.reason,
          }),
        );
      } else {
        onToast("ok", t("remoteList.installedToast", { ns, name: a.name, path: result.targetDir }));
      }
      markRemoteInstalled(id);
      await onAfterInstall();
    } catch (e) {
      if (e instanceof InstallBlockedError) {
        setBlockedInstall({ skillName: a.name, verdict: e.verdict });
      } else {
        onToast("error", t("remoteList.installFailedToast", { message: describeError(e) }));
      }
    } finally {
      setInstalling(null);
      setPendingInstallId(null);
    }
  }

  async function handleStarToggle(id: string) {
    if (!cloudApiKey) {
      onToast("error", t("remoteList.signInToStarToast"));
      return;
    }
    const a = remoteArtifacts.find((r) => r.id === id);
    if (!a) return;
    const ns = a.frontmatter.namespace as string | undefined;
    if (!ns) return;
    const wasStarred = starredIds.has(id);
    setBusyId(id);
    try {
      if (wasStarred) {
        await unstarSkill(cloudApiKey, ns, a.name);
        setStarredIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        onToast("ok", t("remoteList.unstarredToast", { ns, name: a.name }));
      } else {
        await starSkill(cloudApiKey, ns, a.name);
        setStarredIds((prev) => new Set(prev).add(id));
        onToast("ok", t("remoteList.starredToast", { ns, name: a.name }));
      }
    } catch (e) {
      const key = wasStarred ? "remoteList.unstarFailedToast" : "remoteList.starFailedToast";
      onToast("error", t(key, { message: describeError(e) }));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    const id = pendingDeleteId;
    if (!id || !cloudApiKey) return;
    const a = remoteArtifacts.find((r) => r.id === id);
    if (!a) return;
    const ns = a.frontmatter.namespace as string | undefined;
    if (!ns) return;
    setBusyId(id);
    try {
      await deleteSkill(cloudApiKey, ns, a.name);
      onToast("ok", t("remoteList.deletedToast", { ns, name: a.name }));
      setPendingDeleteId(null);
      if (onAfterMutation) await onAfterMutation();
    } catch (e) {
      onToast("error", t("remoteList.deleteFailedToast", { message: describeError(e) }));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmVersionAction(choice: { version: string; reason?: string }) {
    const id = pendingVersionActionId;
    if (!id || !cloudApiKey) return;
    const a = remoteArtifacts.find((r) => r.id === id);
    if (!a) return;
    const ns = a.frontmatter.namespace as string | undefined;
    if (!ns) return;
    setBusyId(id);
    try {
      if (pendingVersionActionKind === "yank") {
        await yankSkillVersion(cloudApiKey, ns, a.name, choice.version, choice.reason);
        onToast("ok", t("remoteList.yankedToast", { ns, name: a.name, version: choice.version }));
      } else {
        await setCurrentVersion(cloudApiKey, ns, a.name, choice.version);
        onToast("ok", t("remoteList.setCurrentToast", { ns, name: a.name, version: choice.version }));
      }
      setPendingVersionActionId(null);
      if (onAfterMutation) await onAfterMutation();
    } catch (e) {
      const key = pendingVersionActionKind === "yank" ? "remoteList.yankFailedToast" : "remoteList.setCurrentFailedToast";
      onToast("error", t(key, { message: describeError(e) }));
    } finally {
      setBusyId(null);
    }
  }

  function buildMenuItems(a: typeof remoteArtifacts[number]): RemoteRowMenuItem[] {
    const items: RemoteRowMenuItem[] = [];
    const owned = isOwnerOf(a);
    const starred = starredIds.has(a.id);
    const ns = a.frontmatter.namespace as string | undefined;
    items.push({
      label: starred ? t("remoteList.menuUnstar") : t("remoteList.menuStar"),
      onClick: () => handleStarToggle(a.id),
      disabled: !cloudApiKey || busyId === a.id,
    });
    if (owned && ns) {
      items.push({
        label: t("remoteList.menuManageShare"),
        onClick: () => setPendingShareId(a.id),
      });
      items.push({
        label: t("remoteList.menuSetCurrent"),
        onClick: () => {
          setPendingVersionActionKind("set-current");
          setPendingVersionActionId(a.id);
        },
      });
      items.push({
        label: t("remoteList.menuYank"),
        onClick: () => {
          setPendingVersionActionKind("yank");
          setPendingVersionActionId(a.id);
        },
      });
      items.push({
        label: t("remoteList.menuDelete"),
        danger: true,
        onClick: () => setPendingDeleteId(a.id),
      });
    }
    return items;
  }

  // Default the dialog's scope to whatever the sidebar is currently showing,
  // so a user already in project mode lands on Project pre-selected.
  const defaultDialogScope: "global" | "project" =
    scope === "project" && (projectRoot || recentProjects.length > 0)
      ? "project"
      : "global";
  const pendingArtifact = pendingInstallId
    ? remoteArtifacts.find((r) => r.id === pendingInstallId) ?? null
    : null;
  const pendingDeleteArtifact = pendingDeleteId
    ? remoteArtifacts.find((r) => r.id === pendingDeleteId) ?? null
    : null;
  const pendingShareArtifact = pendingShareId
    ? remoteArtifacts.find((r) => r.id === pendingShareId) ?? null
    : null;
  const pendingVersionArtifact = pendingVersionActionId
    ? remoteArtifacts.find((r) => r.id === pendingVersionActionId) ?? null
    : null;

  return (
    <section className="list-pane remote-list-pane" ref={sectionRef}>
      <div className="list-toolbar">
        <input
          className="search"
          placeholder={t("remoteList.filterPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          onClick={() => {
            if (onReload) void onReload();
          }}
          disabled={!onReload || remoteLoading}
          aria-label={t("remoteList.reloadAria")}
          title={remoteLoading ? t("common.loading") : t("remoteList.reloadTitleIdle")}
          data-testid="remote-list-refresh"
        >
          ↻
        </button>
      </div>
      {remoteLoading && filtered.length === 0 ? (
        <div className="empty">{t("common.loading")}</div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          {remoteArtifacts.length === 0 ? t("remoteList.empty") : t("remoteList.noMatches")}
          {remoteError && <div className="empty-error">{remoteError}</div>}
        </div>
      ) : (
        filtered.map((a) => {
          const isActive = remoteSelectedId === a.id;
          const isLocal = localNames.has(a.name);
          const isInstalled = installedRemoteIds.includes(a.id);
          const desc = String(a.frontmatter.description ?? "").trim();
          const version = a.frontmatter.version as string | undefined;
          const ns = a.frontmatter.namespace as string | undefined;
          const owned = isOwnerOf(a);
          const starred = starredIds.has(a.id);
          return (
            <div key={a.id}>
              <div
                className={`artifact-card ${isActive ? "active" : ""}`}
                onClick={() => setRemoteSelectedId(isActive ? null : a.id)}
              >
                <div className="artifact-name">
                  {a.name}
                  {version && <span className="badge">v{version}</span>}
                  {a.frontmatter.visibility === "private" && (
                    <span className="badge drift">{t("remoteList.privateBadge")}</span>
                  )}
                  {owned && <span className="badge bundle">{t("remoteList.mineBadge")}</span>}
                  {isLocal && <span className="badge bundle">{t("remoteList.localBadge")}</span>}
                </div>
                {desc && <div className="artifact-desc">{truncate(desc, 160)}</div>}
                <div className="artifact-meta">
                  {ns && <span>{ns}</span>}
                  {a.mtimeMs ? (
                    <>
                      <span>·</span>
                      <span>{new Date(a.mtimeMs).toLocaleDateString()}</span>
                    </>
                  ) : null}
                </div>
                <div className="card-actions">
                  <button
                    className="icon-btn"
                    aria-label={starred ? t("remoteList.unstarAria", { name: a.name }) : t("remoteList.starAria", { name: a.name })}
                    title={
                      cloudApiKey
                        ? (starred ? t("remoteList.unstarTitle") : t("remoteList.starTitle"))
                        : t("remoteList.signInToStar")
                    }
                    disabled={!cloudApiKey || busyId === a.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStarToggle(a.id);
                    }}
                  >
                    {starred ? "★" : "☆"}
                  </button>
                  <button
                    className="primary"
                    onClick={(e) => { e.stopPropagation(); startInstall(a.id); }}
                    disabled={installing === a.id || isInstalled}
                  >
                    {installing === a.id ? t("remoteList.installing") : isInstalled ? t("remoteList.installed") : t("remoteList.installButton")}
                  </button>
                  <RemoteRowMenu
                    items={buildMenuItems(a)}
                    ariaLabel={t("remoteList.manageAria", { name: a.name })}
                  />
                </div>
              </div>
              {isActive && (() => {
                const activeVer = remoteSelectedVersion[a.id]
                  ?? (a.frontmatter.version as string | undefined);
                const cacheKey = activeVer ? `${a.id}@${activeVer}` : "";
                const pth = remotePathToHash[cacheKey] ?? {};
                const body = remoteBodyCache[cacheKey];
                if (Object.keys(pth).length === 0) return null;
                return (
                  <div className="card-tree">
                    <RemoteAttachmentTree
                      artifactId={a.id}
                      artifactPath={a.path}
                      attachments={a.attachments}
                      pathToHash={pth}
                      skillMdPath={findSkillMdPath(
                        Object.entries(pth).map(
                          ([path, hash]): DownloadManifestFile => ({ path, hash, size: 0 }),
                        ),
                      )}
                      skillBody={body}
                      onToast={onToast}
                    />
                  </div>
                );
              })()}
            </div>
          );
        })
      )}
      {remoteHasMore && (
        <div className="remote-load-more">
          {remoteLoadingMore ? t("remoteList.loadingMore") : t("remoteList.scrollForMore")}
        </div>
      )}
      {pendingArtifact && (
        <InstallScopeDialog
          artifactName={pendingArtifact.name}
          tool={tool}
          recentProjects={recentProjects}
          defaultScope={defaultDialogScope}
          defaultProjectRoot={projectRoot}
          busy={installing === pendingArtifact.id}
          onConfirm={confirmInstall}
          onCancel={() => {
            if (installing === pendingArtifact.id) return;
            setPendingInstallId(null);
          }}
        />
      )}
      {blockedInstall && (
        <QuarantineDialog
          skillName={blockedInstall.skillName}
          verdict={blockedInstall.verdict}
          onClose={() => setBlockedInstall(null)}
        />
      )}
      {pendingDeleteArtifact && (
        <ConfirmDialog
          title={t("remoteList.deleteTitle", { name: pendingDeleteArtifact.name })}
          message={
            <>
              <div>{t("remoteList.deleteDescription")}</div>
              <div className="confirm-target-path">
                {pendingDeleteArtifact.frontmatter.namespace as string}
                /{pendingDeleteArtifact.name}
              </div>
              <div className="confirm-warning">
                {t("remoteList.deleteWarning")}
              </div>
            </>
          }
          confirmLabel={t("remoteList.deleteConfirm")}
          danger
          busy={busyId === pendingDeleteArtifact.id}
          onConfirm={confirmDelete}
          onCancel={() => {
            if (busyId === pendingDeleteArtifact.id) return;
            setPendingDeleteId(null);
          }}
        />
      )}
      {pendingShareArtifact && cloudApiKey && (() => {
        const ns = pendingShareArtifact.frontmatter.namespace as string | undefined;
        const ver = pendingShareArtifact.frontmatter.version as string | undefined;
        if (!ns || !ver) return null;
        return (
          <ShareLinksDialog
            apiKey={cloudApiKey}
            ns={ns}
            name={pendingShareArtifact.name}
            defaultVersion={ver}
            onClose={() => setPendingShareId(null)}
            onToast={onToast}
          />
        );
      })()}
      {pendingVersionArtifact && cloudApiKey && (() => {
        const ns = pendingVersionArtifact.frontmatter.namespace as string | undefined;
        const ver = pendingVersionArtifact.frontmatter.version as string | undefined;
        if (!ns) return null;
        return (
          <VersionActionDialog
            apiKey={cloudApiKey}
            ns={ns}
            name={pendingVersionArtifact.name}
            defaultVersion={ver}
            action={pendingVersionActionKind}
            busy={busyId === pendingVersionArtifact.id}
            onConfirm={confirmVersionAction}
            onCancel={() => {
              if (busyId === pendingVersionArtifact.id) return;
              setPendingVersionActionId(null);
            }}
          />
        );
      })()}
    </section>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function describeError(e: unknown): string {
  if (e instanceof SkillSafeError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

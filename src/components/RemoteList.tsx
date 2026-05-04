import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { installSkill } from "../lib/skillsafe/install";
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
}

export function RemoteList({ onToast, onAfterInstall, onLoadMore, onAfterMutation }: Props) {
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
      onToast("error", "Skill is missing namespace or version.");
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
        // Inherit the sidebar's selected agent so the skill lands in that
        // agent's skills dir (~/.cursor/skills, ~/.codex/skills, …) rather
        // than always under Claude.
        tool,
        scope: choice.scope,
        projectRoot: choice.scope === "project" ? choice.projectRoot : undefined,
      });
      onToast("ok", `Installed ${ns}/${a.name} → ${result.targetDir}`);
      markRemoteInstalled(id);
      await onAfterInstall();
    } catch (e) {
      onToast("error", `Install failed: ${describeError(e)}`);
    } finally {
      setInstalling(null);
      setPendingInstallId(null);
    }
  }

  async function handleStarToggle(id: string) {
    if (!cloudApiKey) {
      onToast("error", "Sign in to star skills.");
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
        onToast("ok", `Unstarred ${ns}/${a.name}.`);
      } else {
        await starSkill(cloudApiKey, ns, a.name);
        setStarredIds((prev) => new Set(prev).add(id));
        onToast("ok", `Starred ${ns}/${a.name}.`);
      }
    } catch (e) {
      onToast("error", `${wasStarred ? "Unstar" : "Star"} failed: ${describeError(e)}`);
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
      onToast("ok", `Deleted ${ns}/${a.name}.`);
      setPendingDeleteId(null);
      if (onAfterMutation) await onAfterMutation();
    } catch (e) {
      onToast("error", `Delete failed: ${describeError(e)}`);
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
        onToast("ok", `Yanked ${ns}/${a.name} v${choice.version}.`);
      } else {
        await setCurrentVersion(cloudApiKey, ns, a.name, choice.version);
        onToast("ok", `Set current version of ${ns}/${a.name} to v${choice.version}.`);
      }
      setPendingVersionActionId(null);
      if (onAfterMutation) await onAfterMutation();
    } catch (e) {
      const verb = pendingVersionActionKind === "yank" ? "Yank" : "Set current";
      onToast("error", `${verb} failed: ${describeError(e)}`);
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
      label: starred ? "Unstar" : "Star",
      onClick: () => handleStarToggle(a.id),
      disabled: !cloudApiKey || busyId === a.id,
    });
    if (owned && ns) {
      items.push({
        label: "Manage share links…",
        onClick: () => setPendingShareId(a.id),
      });
      items.push({
        label: "Set current version…",
        onClick: () => {
          setPendingVersionActionKind("set-current");
          setPendingVersionActionId(a.id);
        },
      });
      items.push({
        label: "Yank a version…",
        onClick: () => {
          setPendingVersionActionKind("yank");
          setPendingVersionActionId(a.id);
        },
      });
      items.push({
        label: "Delete skill…",
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
          placeholder="Filter remote…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {remoteLoading && filtered.length === 0 ? (
        <div className="empty">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          {remoteArtifacts.length === 0 ? "No remote skills found." : "No matches."}
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
                    <span className="badge drift">private</span>
                  )}
                  {owned && <span className="badge bundle">mine</span>}
                  {isLocal && <span className="badge bundle">local ✓</span>}
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
                    aria-label={starred ? `Unstar ${a.name}` : `Star ${a.name}`}
                    title={
                      cloudApiKey
                        ? (starred ? "Unstar" : "Star")
                        : "Sign in to star"
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
                    {installing === a.id ? "Installing…" : isInstalled ? "Installed ✓" : "Install"}
                  </button>
                  <RemoteRowMenu
                    items={buildMenuItems(a)}
                    ariaLabel={`Manage ${a.name}`}
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
          {remoteLoadingMore ? "Loading more…" : "Scroll for more"}
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
      {pendingDeleteArtifact && (
        <ConfirmDialog
          title={`Delete ${pendingDeleteArtifact.name}?`}
          message={
            <>
              <div>
                This soft-deletes the skill on skillsafe.ai, revoking its share
                links and all versions:
              </div>
              <div className="confirm-target-path">
                {pendingDeleteArtifact.frontmatter.namespace as string}
                /{pendingDeleteArtifact.name}
              </div>
              <div className="confirm-warning">
                ⚠ Existing installs will keep working, but no one will be able
                to install or browse this skill again.
              </div>
            </>
          }
          confirmLabel="Delete"
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

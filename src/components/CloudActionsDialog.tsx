import { useEffect, useMemo, useState } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner } from "../lib/tauriAdapters";
import {
  saveSkill,
  createShareLink,
  getSkill,
  SkillSafeError,
} from "../lib/skillsafe/client";
import { collectBundleFiles } from "../lib/skillsafe/bundle";
import type { CloudShareLink } from "../lib/skillsafe/types";

type Tab = "save" | "share";

interface Props {
  onClose: () => void;
  onToast: (kind: "ok" | "error", text: string) => void;
  // When set, the Save tab pre-selects this artifact id and locks the
  // bundle picker so the user can't pivot away from the row they clicked.
  presetArtifactId?: string;
  // Fires after a successful publish; the host uses this to refresh the
  // cloud panel so a freshly-uploaded skill shows up in "Mine" right away.
  onAfterSave?: () => Promise<void> | void;
}

export function CloudActionsDialog({ onClose, onToast, presetArtifactId, onAfterSave }: Props) {
  const { t } = useTranslation();
  const { cloudApiKey, cloudAccount, artifacts } = useApp();
  const [tab, setTab] = useState<Tab>("save");

  if (!cloudApiKey) {
    return (
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="dialog cloud-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="cloud-header">
            <h3>{t("cloudActions.title")}</h3>
          </div>
          <div className="cloud-panel">
            <div className="cloud-hint">{t("cloudActions.signInHint")}</div>
          </div>
          <div className="dialog-row">
            <button onClick={onClose}>{t("common.close")}</button>
          </div>
        </div>
      </div>
    );
  }

  const namespace = cloudAccount?.namespace ?? "";

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog cloud-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cloud-header">
          <h3>{t("cloudActions.title")}</h3>
          <div className="cloud-tabs">
            <TabButton active={tab === "save"} onClick={() => setTab("save")}>{t("cloudActions.tabSave")}</TabButton>
            <TabButton active={tab === "share"} onClick={() => setTab("share")}>{t("cloudActions.tabShare")}</TabButton>
          </div>
        </div>

        {tab === "save" && (
          <SavePanel
            cloudApiKey={cloudApiKey}
            namespace={namespace}
            artifacts={artifacts}
            onToast={onToast}
            presetArtifactId={presetArtifactId}
            onAfterSave={onAfterSave}
            t={t}
          />
        )}
        {tab === "share" && (
          <SharePanel cloudApiKey={cloudApiKey} namespace={namespace} onToast={onToast} t={t} />
        )}

        <div className="dialog-row">
          <button onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`cloud-tab ${active ? "active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

function SavePanel({
  cloudApiKey,
  namespace,
  artifacts,
  onToast,
  presetArtifactId,
  onAfterSave,
  t,
}: {
  cloudApiKey: string;
  namespace: string;
  artifacts: import("../lib/artifacts/types").MarkdownArtifact[];
  onToast: (kind: "ok" | "error", text: string) => void;
  presetArtifactId?: string;
  onAfterSave?: () => Promise<void> | void;
  t: TFunction;
}) {
  const bundles = useMemo(
    () => artifacts.filter((a) => a.isBundle && a.bundleDir),
    [artifacts],
  );
  const presetMatch = presetArtifactId
    ? bundles.find((b) => b.id === presetArtifactId)
    : null;
  const [bundleId, setBundleId] = useState<string>(
    presetMatch?.id ?? bundles[0]?.id ?? "",
  );
  const [version, setVersion] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [changelog, setChangelog] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = bundles.find((b) => b.id === bundleId) ?? null;

  // Auto-fill the version field when the user picks a bundle. The skillsafe.ai
  // API requires a semver, so rather than make the user type one we default to:
  //   1. the bundle's frontmatter `version` (if it parses as semver), else
  //   2. the cloud's latest_version + 1 patch (if the skill already exists), else
  //   3. "0.1.0".
  // The user can still type their own; we only overwrite an empty field.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      const resolved = await resolveDefaultVersion(selected, namespace, cloudApiKey);
      if (!cancelled) {
        setVersion((v) => (v.trim() ? v : resolved));
      }
    })();
    return () => { cancelled = true; };
  }, [selected, namespace, cloudApiKey]);

  async function handleSave() {
    if (!selected || !selected.bundleDir) return;
    setBusy(true);
    try {
      const effectiveVersion = version.trim()
        || (await resolveDefaultVersion(selected, namespace, cloudApiKey));
      const { files, manifest } = await collectBundleFiles(tauriFs, tauriJoiner, selected.bundleDir);
      const tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean);
      const { data } = await saveSkill(
        cloudApiKey,
        namespace,
        selected.name,
        files,
        {
          version: effectiveVersion,
          description: description || (selected.frontmatter.description as string | undefined),
          category: category || undefined,
          tags: tags.length ? tags : undefined,
          changelog: changelog || undefined,
          file_manifest: manifest,
        },
      );
      onToast("ok", t("cloudActions.savedToast", { namespace, name: selected.name, version: data.version }));
      // Reflect the version that actually got published, so the field is in
      // sync if the user immediately re-saves.
      setVersion(data.version);
      // Refresh the cloud listing so the freshly-published skill shows up
      // in "Mine" without the user having to manually re-search.
      if (onAfterSave) await onAfterSave();
    } catch (e) {
      onToast("error", t("cloudActions.saveFailedToast", { message: describeError(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cloud-panel">
      {bundles.length === 0 ? (
        <div className="cloud-empty">{t("cloudActions.noBundles")}</div>
      ) : (
        <>
          <div className="fm-field">
            <label className="fm-label">{t("cloudActions.skillBundle")}</label>
            <select
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              disabled={!!presetMatch}
            >
              {bundles.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}{b.scope === "project" ? t("cloudActions.projectSuffix") : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="fm-field">
            <label className="fm-label">{t("cloudActions.target")}</label>
            <div className="cloud-static">{namespace || t("cloudActions.unknownNamespace")}/{selected?.name ?? ""}</div>
          </div>
          <div className="fm-field">
            <label className="fm-label">{t("cloudActions.versionLabel")}</label>
            <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder={t("cloudActions.versionPlaceholder")} />
          </div>
          <div className="fm-field">
            <label className="fm-label">{t("cloudActions.description")}</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="fm-field">
            <label className="fm-label">{t("cloudActions.category")}</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div className="fm-field">
            <label className="fm-label">{t("cloudActions.tagsLabel")}</label>
            <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder={t("cloudActions.tagsPlaceholder")} />
          </div>
          <div className="fm-field">
            <label className="fm-label">{t("cloudActions.changelog")}</label>
            <textarea value={changelog} onChange={(e) => setChangelog(e.target.value)} rows={3} />
          </div>
          <div className="dialog-row">
            <button className="primary" onClick={handleSave} disabled={busy || !selected}>
              {busy ? t("cloudActions.saving") : t("cloudActions.saveButton")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SharePanel({
  cloudApiKey,
  namespace,
  onToast,
  t,
}: {
  cloudApiKey: string;
  namespace: string;
  onToast: (kind: "ok" | "error", text: string) => void;
  t: TFunction;
}) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [expiresIn, setExpiresIn] = useState<"never" | "1d" | "7d" | "30d">("never");
  const [link, setLink] = useState<CloudShareLink | null>(null);
  const [busy, setBusy] = useState(false);

  async function fillCurrentVersion() {
    if (!name) return;
    try {
      const { data } = await getSkill(namespace, name, cloudApiKey);
      if (data.latest_version) setVersion(data.latest_version);
    } catch (e) {
      onToast("error", t("cloudActions.lookupFailed", { message: describeError(e) }));
    }
  }

  async function handleCreate() {
    if (!name || !version) return;
    setBusy(true);
    try {
      const { data } = await createShareLink(cloudApiKey, namespace, name, version, {
        visibility,
        expires_in: expiresIn,
      });
      setLink(data);
      onToast("ok", t("cloudActions.shareLinkCreatedToast"));
    } catch (e) {
      onToast("error", t("cloudActions.shareFailedToast", { message: describeError(e) }));
    } finally {
      setBusy(false);
    }
  }

  const shareUrl = link ? `https://skillsafe.ai/share/${link.share_id}` : "";

  return (
    <div className="cloud-panel">
      <div className="fm-field">
        <label className="fm-label">{t("cloudActions.skillLabel")}</label>
        <div className="cloud-row">
          <span className="cloud-static">{namespace}/</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("cloudActions.skillPlaceholder")} />
          <button onClick={fillCurrentVersion} disabled={!name}>{t("cloudActions.latestButton")}</button>
        </div>
      </div>
      <div className="fm-field">
        <label className="fm-label">{t("versionAction.versionLabel")}</label>
        <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder={t("cloudActions.versionPlaceholder")} />
      </div>
      <div className="fm-field">
        <label className="fm-label">{t("cloudActions.visibility")}</label>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "public")}>
          <option value="private">{t("cloudActions.visibilityPrivate")}</option>
          <option value="public">{t("cloudActions.visibilityPublic")}</option>
        </select>
      </div>
      <div className="fm-field">
        <label className="fm-label">{t("cloudActions.expiresIn")}</label>
        <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value as typeof expiresIn)}>
          <option value="never">{t("cloudActions.expiresNever")}</option>
          <option value="1d">{t("cloudActions.expires1d")}</option>
          <option value="7d">{t("cloudActions.expires7d")}</option>
          <option value="30d">{t("cloudActions.expires30d")}</option>
        </select>
      </div>
      <div className="dialog-row">
        <button className="primary" onClick={handleCreate} disabled={busy || !name || !version}>
          {busy ? t("cloudActions.creating") : t("cloudActions.createShareLink")}
        </button>
      </div>
      {link && (
        <div className="cloud-share-result">
          <div className="cloud-share-url">{shareUrl}</div>
          <div className="cloud-row">
            <button onClick={() => navigator.clipboard.writeText(shareUrl).then(() => onToast("ok", t("cloudActions.copiedToast")))}>
              {t("common.copy")}
            </button>
            <button onClick={() => shellOpen(shareUrl).catch(() => {})}>{t("common.open")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function describeError(e: unknown): string {
  if (e instanceof SkillSafeError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// skillsafe.ai's semver pattern: MAJOR.MINOR.PATCH(±prerelease)(±build).
// Backend rejects anything else, so the auto-fill must produce a valid match.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/;

function bumpPatch(v: string): string | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  const [, maj, min, patch] = m;
  return `${maj}.${min}.${Number(patch) + 1}`;
}

async function resolveDefaultVersion(
  artifact: import("../lib/artifacts/types").MarkdownArtifact,
  namespace: string,
  apiKey: string,
): Promise<string> {
  // 1. Frontmatter version, if it's already valid semver.
  const fmVersion = String(artifact.frontmatter.version ?? "").trim();
  if (fmVersion && SEMVER_RE.test(fmVersion)) return fmVersion;

  // 2. Cloud's latest version + patch bump.
  if (namespace) {
    try {
      const { data } = await getSkill(namespace, artifact.name, apiKey);
      if (data.latest_version) {
        const bumped = bumpPatch(data.latest_version);
        if (bumped) return bumped;
      }
    } catch {
      // 404 / network error → fall through to the static default.
    }
  }

  // 3. First-publish default.
  return "0.1.0";
}

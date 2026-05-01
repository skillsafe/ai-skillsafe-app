import Monaco from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/store";
import {
  downloadBlob,
  downloadSkillManifest,
  getSkillVersion,
  listSkillVersions,
  SkillSafeError,
} from "../lib/skillsafe/client";
import { findSkillMdPath, manifestToAttachments } from "../lib/skillsafe/asArtifact";
import { renderMarkdown } from "../lib/markdown";
import { ScanReportPanel } from "./ScanReportPanel";

type LoadStep = "manifest" | "skill" | null;

interface Props {
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function RemoteEditor({ onToast }: Props) {
  const {
    remoteArtifacts,
    remoteSelectedId,
    remoteBodyCache,
    remoteSelectedVersion,
    remoteVersionsCache,
    remoteFailedKeys,
    remoteScanCache,
    remoteViewedFile,
    cacheRemoteBody,
    setRemoteSelectedVersion,
    cacheRemoteVersions,
    markRemoteFailed,
    cacheRemoteScan,
    cloudApiKey,
    resolvedTheme,
  } = useApp();
  const [preview, setPreview] = useState(true);
  const [loadStep, setLoadStep] = useState<LoadStep>(null);
  const [loadBytes, setLoadBytes] = useState(0);
  const [loadTotal, setLoadTotal] = useState<number | null>(null);
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const versionPopoverRef = useRef<HTMLDivElement | null>(null);
  // Refs that mirror live store + prop values so the manifest effect can read
  // them without re-running on every change.
  const remoteBodyCacheRef = useRef(remoteBodyCache);
  const remoteFailedKeysRef = useRef(remoteFailedKeys);
  const onToastRef = useRef(onToast);
  useEffect(() => { remoteBodyCacheRef.current = remoteBodyCache; }, [remoteBodyCache]);
  useEffect(() => { remoteFailedKeysRef.current = remoteFailedKeys; }, [remoteFailedKeys]);
  useEffect(() => { onToastRef.current = onToast; }, [onToast]);

  const artifact = useMemo(
    () => remoteArtifacts.find((a) => a.id === remoteSelectedId) ?? null,
    [remoteArtifacts, remoteSelectedId],
  );

  const ns = artifact?.frontmatter.namespace as string | undefined;
  const latestVersion = artifact?.frontmatter.version as string | undefined;
  const isPrivate = artifact?.frontmatter.visibility === "private";
  const activeVersion = artifact ? remoteSelectedVersion[artifact.id] ?? latestVersion : undefined;
  const cacheKey = artifact && activeVersion ? `${artifact.id}@${activeVersion}` : "";
  const versions = artifact ? remoteVersionsCache[artifact.id] : undefined;

  // Lazy-fetch the version list once per skill.
  useEffect(() => {
    if (!artifact || !ns || versions !== undefined) return;
    if (!latestVersion) return; // skillsets without published versions have no list
    let cancelled = false;
    setVersionsLoading(true);
    listSkillVersions(ns, artifact.name, cloudApiKey)
      .then(({ data }) => {
        if (cancelled) return;
        const list = data.map((v) => v.version);
        cacheRemoteVersions(artifact.id, list.length > 0 ? list : [latestVersion]);
      })
      .catch(() => {
        // fall back to just the latest version
        if (!cancelled) cacheRemoteVersions(artifact.id, [latestVersion]);
      })
      .finally(() => { if (!cancelled) setVersionsLoading(false); });
    return () => { cancelled = true; };
  }, [artifact, ns, latestVersion, versions, cloudApiKey, cacheRemoteVersions]);

  // Lazy-fetch manifest + SKILL.md for the active (id, version) pair. We
  // intentionally exclude `remoteBodyCache`, `remoteFailedKeys`, and `onToast`
  // from the dep array — they would each cause a re-fire after the very state
  // updates this effect produces, looping on every 404. Caching the failure in
  // the store gives us idempotency without depending on the cache for input.
  useEffect(() => {
    if (!artifact || !ns || !activeVersion) return;
    if (remoteBodyCacheRef.current[cacheKey] !== undefined) return;
    if (remoteFailedKeysRef.current[cacheKey] !== undefined) return;

    let cancelled = false;
    setLoadStep("manifest");
    setLoadBytes(0);
    setLoadTotal(null);
    (async () => {
      try {
        const { data } = await downloadSkillManifest(ns, artifact.name, activeVersion, cloudApiKey);
        if (cancelled) return;
        const skillMdPath = findSkillMdPath(data.files);
        const totalBytes = data.files.reduce((acc, f) => acc + (f.size || 0), 0);
        setLoadTotal(totalBytes || null);
        let body = "";
        if (skillMdPath) {
          const fileEntry = data.files.find((f) => f.path === skillMdPath)!;
          setLoadStep("skill");
          const bytes = await downloadBlob(fileEntry.hash, cloudApiKey);
          if (cancelled) return;
          setLoadBytes(fileEntry.size);
          body = new TextDecoder().decode(bytes);
        }
        const attachments = manifestToAttachments(data.files);
        const pathToHash: Record<string, string> = {};
        for (const f of data.files) pathToHash[f.path] = f.hash;
        if (!cancelled) cacheRemoteBody(cacheKey, body, attachments, pathToHash);
      } catch (e) {
        if (cancelled) return;
        const msg = describeError(e);
        markRemoteFailed(cacheKey, msg);
        onToastRef.current("error", `Couldn't load skill: ${msg}`);
      } finally {
        if (!cancelled) {
          setLoadStep(null);
          setLoadBytes(0);
          setLoadTotal(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [artifact, ns, activeVersion, cacheKey, cloudApiKey, cacheRemoteBody, markRemoteFailed]);

  // Lazy-fetch the scan report alongside the manifest. Skip for private
  // skills — owner-only views don't need the public-trust signal, and the
  // banner would just be noise.
  useEffect(() => {
    if (!artifact || !ns || !activeVersion || isPrivate) return;
    if (remoteScanCache[cacheKey] !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await getSkillVersion(ns, artifact.name, activeVersion, cloudApiKey);
        if (cancelled) return;
        const pub = (data.scan_reports ?? []).find((r) => r.report_type === "publisher")
          ?? data.scan_reports?.[0] ?? null;
        cacheRemoteScan(cacheKey, pub);
      } catch {
        if (!cancelled) cacheRemoteScan(cacheKey, null);
      }
    })();
    return () => { cancelled = true; };
  }, [artifact, ns, activeVersion, cacheKey, cloudApiKey, cacheRemoteScan, isPrivate]);

  // Close version popover when clicking outside.
  useEffect(() => {
    if (!versionMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!versionPopoverRef.current?.contains(e.target as Node)) {
        setVersionMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [versionMenuOpen]);

  const skillBody = artifact ? remoteBodyCache[cacheKey] ?? artifact.body : "";
  const showing = remoteViewedFile ?? (artifact
    ? { name: artifact.name, path: artifact.path, content: skillBody, language: "markdown" }
    : { name: "", path: "", content: "", language: "markdown" });
  const isMarkdown = showing.language === "markdown";
  const isImage = showing.language === "image";
  const showPreview = isMarkdown && preview;
  const previewHtml = useMemo(
    () => (showPreview ? renderMarkdown(showing.content || "") : ""),
    [showPreview, showing.content],
  );

  if (!artifact) {
    return (
      <section className="editor-pane remote-editor-pane">
        <div className="empty">Select a remote skill on the left to view.</div>
      </section>
    );
  }

  const description = String(artifact.frontmatter.description ?? "").trim();
  const repoUrl = (artifact.frontmatter.github_repo_url as string | undefined)
    ?? (typeof artifact.path === "string" && ns ? `https://skillsafe.ai/skill/${ns}/${artifact.name}/` : undefined);
  const unversioned = !!ns && !latestVersion;
  const skillPath = ns ? `${ns}/${artifact.name}` : artifact.path;
  const loadError = !unversioned ? remoteFailedKeys[cacheKey] : undefined;
  const scanReport = !unversioned ? remoteScanCache[cacheKey] : undefined;
  const showScanPanel = !isPrivate && !remoteViewedFile && !unversioned && !loadError && scanReport !== undefined;

  return (
    <section className="editor-pane remote-editor-pane">
      <div className="editor-toolbar">
        <div className="editor-title">{showing.name || artifact.name}</div>
        <span className="cloud-static">{remoteViewedFile ? remoteViewedFile.path : skillPath}</span>
        {!remoteViewedFile && activeVersion && (
          <div className="version-badge-wrap" ref={versionPopoverRef}>
            <button
              className="version-badge"
              onClick={() => setVersionMenuOpen((o) => !o)}
              title="Show all versions"
              aria-haspopup="listbox"
              aria-expanded={versionMenuOpen}
            >
              v{activeVersion}
              <span className="version-caret">▾</span>
            </button>
            {versionMenuOpen && (
              <div className="version-menu" role="listbox">
                {versionsLoading && <div className="version-menu-hint">Loading versions…</div>}
                {!versionsLoading && versions && versions.length === 0 && (
                  <div className="version-menu-hint">No published versions.</div>
                )}
                {versions?.map((v) => (
                  <button
                    key={v}
                    role="option"
                    aria-selected={v === activeVersion}
                    className={`version-menu-item ${v === activeVersion ? "active" : ""}`}
                    onClick={() => {
                      setRemoteSelectedVersion(artifact.id, v);
                      setVersionMenuOpen(false);
                    }}
                  >
                    v{v}
                    {v === latestVersion && <span className="badge">latest</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {isMarkdown && !unversioned && (
          <button onClick={() => setPreview((p) => !p)}>
            {preview ? "Source" : "Preview"}
          </button>
        )}
      </div>
      {loadStep && (
        <div className="dl-progress" role="status" aria-live="polite">
          <div className="dl-progress-bar">
            <div
              className="dl-progress-fill"
              style={{
                width:
                  loadStep === "manifest"
                    ? "20%"
                    : loadTotal && loadBytes
                      ? `${Math.min(100, 20 + (loadBytes / loadTotal) * 80)}%`
                      : "65%",
              }}
            />
          </div>
          <div className="dl-progress-label">
            {loadStep === "manifest"
              ? "Fetching manifest…"
              : `Downloading SKILL.md${loadTotal ? ` (${formatBytes(loadBytes)} / ${formatBytes(loadTotal)})` : "…"}`}
          </div>
        </div>
      )}
      <div className="body-only">
        {unversioned ? (
          <UnversionedHint
            ns={ns!}
            name={artifact.name}
            description={description}
            repoUrl={repoUrl}
          />
        ) : loadError ? (
          <LoadErrorHint
            ns={ns!}
            name={artifact.name}
            version={activeVersion!}
            error={loadError}
            description={description}
            repoUrl={repoUrl}
          />
        ) : isImage ? (
          <div className="img-preview">
            <img src={showing.content} alt={showing.name} />
          </div>
        ) : showPreview ? (
          <div className="md-with-scan">
            {showScanPanel && <ScanReportPanel report={scanReport} />}
            <div className="md-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        ) : (
          <Monaco
            key={showing.path || cacheKey}
            height="100%"
            language={showing.language}
            theme={resolvedTheme === "light" ? "vs" : "vs-dark"}
            value={showing.content}
            // Monaco's automatic layout collapses to 5×5 when the parent is
            // briefly small at mount time; nudge it once mounted so window
            // resizes and bottom-row reveals fix themselves.
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
  );
}

function LoadErrorHint({
  ns,
  name,
  version,
  error,
  description,
  repoUrl,
}: {
  ns: string;
  name: string;
  version: string;
  error: string;
  description: string;
  repoUrl?: string;
}) {
  // The API returns the same `not_found: ... does not exist` for two distinct
  // cases: (a) the skill genuinely isn't there, and (b) it's private and the
  // current API key isn't the owner. We can't tell the two apart without
  // hitting the API again, so the explanation has to cover both.
  const isMissingSkill =
    error.toLowerCase().includes("does not exist") ||
    error.toLowerCase().startsWith("not_found");
  return (
    <div className="md-preview">
      <h2>{ns}/{name}</h2>
      {description && <p>{description}</p>}
      <p style={{ color: "var(--error)" }}>
        Couldn't load <code>v{version}</code> from skillsafe.ai: {error}
      </p>
      {isMissingSkill ? (
        <>
          <p style={{ color: "var(--muted)" }}>
            <strong>{ns}/{name}</strong> isn't reachable. A few things this
            could mean:
          </p>
          <ul style={{ color: "var(--muted)", marginTop: 0 }}>
            <li>
              The publish didn't actually land at this namespace — confirm in
              Settings that you're signed in as <code>{ns}</code>, then try
              uploading again.
            </li>
            <li>
              The skill is private and the current sign-in isn't its owner.
              Sign in as the owner from Settings.
            </li>
            <li>The skill was deleted on skillsafe.ai.</li>
          </ul>
        </>
      ) : (
        <p style={{ color: "var(--muted)" }}>
          The manifest or one of its blobs is missing on the server. Try a
          different version from the dropdown above, or open the skill page
          on skillsafe.ai.
        </p>
      )}
      {repoUrl && (
        <p>
          <a href={repoUrl} target="_blank" rel="noopener noreferrer">
            {repoUrl}
          </a>
        </p>
      )}
    </div>
  );
}

function UnversionedHint({
  ns,
  name,
  description,
  repoUrl,
}: {
  ns: string;
  name: string;
  description: string;
  repoUrl?: string;
}) {
  return (
    <div className="md-preview">
      <h2>{ns}/{name}</h2>
      {description && <p>{description}</p>}
      <p style={{ color: "var(--muted)" }}>
        This skill has no published version on skillsafe.ai yet, so the file
        contents can't be fetched. Open the source repository to view it.
      </p>
      {repoUrl && (
        <p>
          <a href={repoUrl} target="_blank" rel="noopener noreferrer">
            {repoUrl}
          </a>
        </p>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function describeError(e: unknown): string {
  if (e instanceof SkillSafeError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

import { useEffect, useState } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  SkillSafeError,
  type ShareLinkListItem,
} from "../lib/skillsafe/client";

interface Props {
  apiKey: string;
  ns: string;
  name: string;
  // Default version for creating new share links. Existing links cover all
  // versions of the skill regardless of which one we pass to listShareLinks.
  defaultVersion: string;
  versions?: ReadonlyArray<string>;
  onClose: () => void;
  onToast: (kind: "ok" | "error", text: string) => void;
}

type ExpiresIn = "never" | "1d" | "7d" | "30d";

export function ShareLinksDialog({
  apiKey,
  ns,
  name,
  defaultVersion,
  versions,
  onClose,
  onToast,
}: Props) {
  const [links, setLinks] = useState<ShareLinkListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Quick-create form state.
  const [createVersion, setCreateVersion] = useState<string>(defaultVersion);
  const [createVisibility, setCreateVisibility] = useState<"private" | "public">("private");
  const [createExpires, setCreateExpires] = useState<ExpiresIn>("never");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await listShareLinks(apiKey, ns, name, defaultVersion);
        if (!cancelled) setLinks(data);
      } catch (e) {
        if (!cancelled) setLoadError(describeError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [apiKey, ns, name, defaultVersion]);

  async function handleRevoke(shareId: string) {
    if (!confirm("Revoke this share link? Anyone using it will lose access.")) return;
    setBusyId(shareId);
    try {
      await revokeShareLink(apiKey, shareId);
      setLinks((prev) => (prev ?? []).filter((l) => l.share_id !== shareId));
      onToast("ok", "Share link revoked.");
    } catch (e) {
      onToast("error", `Revoke failed: ${describeError(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleCreate() {
    if (!createVersion) {
      onToast("error", "Pick a version first.");
      return;
    }
    setCreating(true);
    try {
      const { data } = await createShareLink(apiKey, ns, name, createVersion, {
        visibility: createVisibility,
        expires_in: createExpires,
      });
      setLinks((prev) => [
        {
          share_id: data.share_id,
          version_id: data.skill_id,
          version: data.version,
          visibility: data.visibility,
          allow_reshare: false,
          access_count: 0,
          expires_at: data.expires_at,
          revoked: false,
          created_at: data.created_at,
        },
        ...(prev ?? []),
      ]);
      onToast("ok", "Share link created.");
    } catch (e) {
      onToast("error", `Share failed: ${describeError(e)}`);
    } finally {
      setCreating(false);
    }
  }

  function urlFor(shareId: string): string {
    return `https://skillsafe.ai/share/${shareId}`;
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog share-links-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Share links — {ns}/{name}</h3>

        <div className="fm-field">
          <label className="fm-label">create new</label>
          <div className="share-create-row">
            <select
              value={createVersion}
              onChange={(e) => setCreateVersion(e.target.value)}
              disabled={!versions || versions.length === 0}
              title="version"
            >
              {(versions ?? [defaultVersion]).map((v) => (
                <option key={v} value={v}>v{v}</option>
              ))}
            </select>
            <select
              value={createVisibility}
              onChange={(e) => setCreateVisibility(e.target.value as "private" | "public")}
              title="visibility"
            >
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
            <select
              value={createExpires}
              onChange={(e) => setCreateExpires(e.target.value as ExpiresIn)}
              title="expires in"
            >
              <option value="never">never</option>
              <option value="1d">1 day</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
            </select>
            <button className="primary" onClick={handleCreate} disabled={creating}>
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        </div>

        <div className="share-links-list">
          {!links && !loadError && <div className="cloud-hint">Loading…</div>}
          {loadError && <div className="empty-error">{loadError}</div>}
          {links && links.length === 0 && (
            <div className="cloud-hint">No share links yet.</div>
          )}
          {links?.map((l) => {
            const url = urlFor(l.share_id);
            const expired = l.expires_at && new Date(l.expires_at) < new Date();
            return (
              <div key={l.share_id} className={`share-link-row ${l.revoked ? "revoked" : ""}`}>
                <div className="share-link-meta">
                  <span className="badge">{l.visibility}</span>
                  <span className="badge">v{l.version}</span>
                  {expired && <span className="badge drift">expired</span>}
                  {l.revoked && <span className="badge drift">revoked</span>}
                  <span className="cloud-static">{l.access_count} access{l.access_count === 1 ? "" : "es"}</span>
                </div>
                <div className="share-link-url" title={url}>{url}</div>
                <div className="share-link-actions">
                  <button
                    onClick={() => navigator.clipboard.writeText(url).then(() => onToast("ok", "Copied."))}
                    disabled={l.revoked}
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => shellOpen(url).catch(() => {})}
                    disabled={l.revoked}
                  >
                    Open
                  </button>
                  <button
                    className="danger"
                    onClick={() => handleRevoke(l.share_id)}
                    disabled={l.revoked || busyId === l.share_id}
                  >
                    {busyId === l.share_id ? "…" : "Revoke"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="dialog-row">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function describeError(e: unknown): string {
  if (e instanceof SkillSafeError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

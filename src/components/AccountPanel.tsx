import { useState } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { fetchAccount, runDeviceFlow } from "../lib/skillsafe/auth";
import { SkillSafeError } from "../lib/skillsafe/client";
import { useApp } from "../lib/store";

interface Props {
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function AccountPanel({ onToast }: Props) {
  const { cloudApiKey, cloudAccount, setCloudAuth } = useApp();
  const [signingIn, setSigningIn] = useState(false);

  async function handleSignIn() {
    setSigningIn(true);
    try {
      const apiKey = await runDeviceFlow({
        onAuthUrl: (url) => {
          shellOpen(url).then(
            () => onToast("ok", "Approve sign-in in your browser…"),
            (e) => {
              console.error("shell.open failed:", e);
              onToast("error", `Couldn't open browser (${describeError(e)}). Open manually: ${url}`);
            },
          );
        },
      });
      const account = await fetchAccount(apiKey);
      setCloudAuth(apiKey, account);
      onToast("ok", `Signed in as ${account.namespace}`);
    } catch (e) {
      onToast("error", `Sign-in failed: ${describeError(e)}`);
    } finally {
      setSigningIn(false);
    }
  }

  function handleLogout() {
    setCloudAuth(null, null);
    onToast("ok", "Signed out.");
  }

  if (!cloudApiKey) {
    return (
      <div className="cloud-panel cloud-account">
        <p>Sign in to save, share, and install private skills via skillsafe.ai. Public skills can be installed without signing in.</p>
        <div className="dialog-row">
          <button className="primary" onClick={handleSignIn} disabled={signingIn}>
            {signingIn ? "Waiting for browser approval…" : "Sign in with skillsafe.ai"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="cloud-panel cloud-account">
      <div className="fm-field">
        <label className="fm-label">namespace</label>
        <div className="cloud-static">{cloudAccount?.namespace ?? "—"}</div>
      </div>
      <div className="fm-field">
        <label className="fm-label">email</label>
        <div className="cloud-static">
          {cloudAccount?.email ?? "—"}
          {cloudAccount && !cloudAccount.email_verified && (
            <span className="badge drift" style={{ marginLeft: 8 }}>unverified</span>
          )}
        </div>
      </div>
      <div className="fm-field">
        <label className="fm-label">tier</label>
        <div className="cloud-static">{cloudAccount?.tier ?? "—"}</div>
      </div>
      <div className="dialog-row">
        <button onClick={handleLogout}>Sign out</button>
      </div>
    </div>
  );
}

function describeError(e: unknown): string {
  if (e instanceof SkillSafeError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

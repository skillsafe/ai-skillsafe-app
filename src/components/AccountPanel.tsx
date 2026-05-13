import { useState } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useTranslation } from "react-i18next";
import { fetchAccount, runDeviceFlow } from "../lib/skillsafe/auth";
import { SkillSafeError } from "../lib/skillsafe/client";
import { useApp } from "../lib/store";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  onToast: (kind: "ok" | "error", text: string) => void;
}

export function AccountPanel({ onToast }: Props) {
  const { t } = useTranslation();
  const { cloudApiKey, cloudAccount, setCloudAuth } = useApp();
  const [signingIn, setSigningIn] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  async function handleSignIn() {
    setSigningIn(true);
    try {
      const apiKey = await runDeviceFlow({
        onAuthUrl: (url) => {
          shellOpen(url).then(
            () => onToast("ok", t("toast.openBrowser")),
            (e) => {
              console.error("shell.open failed:", e);
              onToast("error", t("toast.couldNotOpenBrowser", { reason: describeError(e), url }));
            },
          );
        },
      });
      const account = await fetchAccount(apiKey);
      setCloudAuth(apiKey, account);
      onToast("ok", t("toast.signedInAs", { namespace: account.namespace }));
    } catch (e) {
      onToast("error", t("toast.signInFailed", { message: describeError(e) }));
    } finally {
      setSigningIn(false);
    }
  }

  function handleLogout() {
    setCloudAuth(null, null);
    setConfirmingSignOut(false);
    onToast("ok", t("toast.signOutDone"));
  }

  if (!cloudApiKey) {
    return (
      <div className="cloud-panel cloud-account">
        <p>{t("accountPanel.signedOutHint")}</p>
        <div className="dialog-row">
          <button className="primary" onClick={handleSignIn} disabled={signingIn}>
            {signingIn ? t("accountPanel.waitingApproval") : t("accountPanel.signInWith")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="cloud-panel cloud-account">
      <div className="fm-field">
        <label className="fm-label">{t("accountPanel.namespace")}</label>
        <div className="cloud-static">{cloudAccount?.namespace ?? "—"}</div>
      </div>
      <div className="fm-field">
        <label className="fm-label">{t("accountPanel.email")}</label>
        <div className="cloud-static">
          {cloudAccount?.email ?? "—"}
          {cloudAccount && !cloudAccount.email_verified && (
            <span className="badge drift" style={{ marginLeft: 8 }}>{t("settings.account.unverified")}</span>
          )}
        </div>
      </div>
      <div className="fm-field">
        <label className="fm-label">{t("accountPanel.tier")}</label>
        <div className="cloud-static">{cloudAccount?.tier ?? "—"}</div>
      </div>
      <div className="dialog-row">
        <button onClick={() => setConfirmingSignOut(true)}>{t("accountPanel.signOut")}</button>
      </div>
      {confirmingSignOut && (
        <ConfirmDialog
          title={t("accountPanel.signOutDialogTitle")}
          message={
            <>
              <div>{t("accountPanel.signOutDialogMessage")}</div>
              <div className="confirm-warning" style={{ marginTop: 8 }}>
                {t("accountPanel.signOutDialogNote")}
              </div>
            </>
          }
          confirmLabel={t("accountPanel.signOut")}
          danger
          onConfirm={handleLogout}
          onCancel={() => setConfirmingSignOut(false)}
        />
      )}
    </div>
  );
}

function describeError(e: unknown): string {
  if (e instanceof SkillSafeError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

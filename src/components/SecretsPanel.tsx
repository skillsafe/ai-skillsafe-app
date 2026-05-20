import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { tauriFs } from "../lib/tauriAdapters";
import { atomicWrite } from "../lib/fs";
import { stringifyFrontmatter } from "../lib/frontmatter";
import { setStatus } from "../lib/artifacts/status";
import { rewriteToKeychain, type RewriteOs } from "../lib/secrets/keychainTemplate";
import { SafetyBadge } from "./SafetyBadge";
import type { MarkdownArtifact } from "../lib/artifacts/types";
import type { LocalScanReport } from "../lib/scan/types";

interface Props {
  artifact: MarkdownArtifact;
  /** The local scan report — used to surface only when there are
   * secret_path_* findings to act on. */
  report: LocalScanReport | "scanning" | null | undefined;
  os: RewriteOs;
  onApplied: () => void | Promise<void>;
  onToast?: (kind: "ok" | "error", text: string) => void;
}

export function SecretsPanel({ artifact, report, os, onApplied, onToast }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);

  // Only render the panel when the scan found a secret_path_* finding —
  // otherwise it's noise.
  const hasSecretPaths = useMemo(() => {
    if (!report || report === "scanning") return false;
    const findings = report.result?.raw_findings ?? [];
    return findings.some((f) => f.rule_id.startsWith("secret_path_"));
  }, [report]);

  const preview = useMemo(() => {
    if (!hasSecretPaths || !artifact.bundleDir) return null;
    return rewriteToKeychain(artifact.body, { os });
  }, [artifact.body, artifact.bundleDir, os, hasSecretPaths]);

  if (!hasSecretPaths) return null;
  if (!preview || preview.rewrittenKeys.length === 0) {
    // Findings exist but rewriter found nothing to substitute (e.g. path
    // references without inline KEY=value assignments). Surface a soft hint.
    return (
      <div className="scan-panel scan-panel-warn">
        <div className="scan-panel-row">
          <SafetyBadge variant="medium" label={t("secretsPanel.detectedBadge")} />
          <span className="scan-title">{t("secretsPanel.noAutoFix")}</span>
        </div>
      </div>
    );
  }

  async function apply() {
    if (!artifact.bundleDir || !preview) return;
    setApplying(true);
    try {
      const next = setStatus({ frontmatter: artifact.frontmatter }, "rewritten", "secrets rewritten to keychain");
      const skillPath = artifact.path;
      const out = stringifyFrontmatter(next.frontmatter, preview.body);
      await atomicWrite(tauriFs, skillPath, out);
      onToast?.("ok", t("secretsPanel.appliedToast", { count: preview.rewrittenKeys.length }));
      await onApplied();
    } catch (err) {
      onToast?.("error", err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <details
      className="scan-panel scan-panel-warn"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="scan-panel-row">
        <SafetyBadge variant="medium" label={t("secretsPanel.detectedBadge")} />
        <span className="scan-title">
          {t("secretsPanel.title", { count: preview.rewrittenKeys.length })}
        </span>
      </summary>
      <div className="scan-panel-body">
        <p className="dialog-hint">{t("secretsPanel.hint", { os })}</p>
        <div className="form-row">
          <strong>{t("secretsPanel.willRewrite")}</strong>
          <ul className="quarantine-rule-list">
            {preview.rewrittenKeys.map((k) => (
              <li key={k}><code>{k}</code></li>
            ))}
          </ul>
        </div>
        <div className="form-row dialog-actions">
          <button type="button" onClick={apply} disabled={applying}>
            {applying ? t("secretsPanel.applying") : t("secretsPanel.apply")}
          </button>
        </div>
      </div>
    </details>
  );
}

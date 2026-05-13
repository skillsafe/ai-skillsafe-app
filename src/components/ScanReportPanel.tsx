import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScanReport } from "../lib/skillsafe/client";

interface Finding {
  rule_id?: string;
  severity?: string;
  file?: string;
  line?: number;
  message?: string;
  classification?: string;
}

interface BomSummary {
  total_files_scanned?: number;
  files_with_capabilities?: number;
  capability_count?: Record<string, number>;
  risk_surface?: string; // "none" | "low" | "medium" | "high"
}

interface Props {
  report: ScanReport | null | undefined;
}

// Mirror of skillsafe.ai's security/BOM summary in compact form.
export function ScanReportPanel({ report }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const findings = useMemo<Finding[]>(() => {
    if (!report?.findings_summary) return [];
    try {
      const parsed =
        typeof report.findings_summary === "string"
          ? JSON.parse(report.findings_summary)
          : report.findings_summary;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [report?.findings_summary]);

  const bom = useMemo<BomSummary>(() => {
    if (!report?.bom_summary) return {};
    try {
      return typeof report.bom_summary === "string"
        ? JSON.parse(report.bom_summary)
        : report.bom_summary;
    } catch {
      return {};
    }
  }, [report?.bom_summary]);

  if (report === null) {
    return (
      <div className="scan-panel scan-panel-muted">
        <div className="scan-panel-row">
          <span className="scan-icon" aria-hidden="true">⊘</span>
          <span className="scan-title">{t("scanReport.notScanned")}</span>
          <span className="scan-hint">{t("scanReport.notScannedHint")}</span>
        </div>
      </div>
    );
  }
  if (!report) return null;

  const isClean = !!report.clean;
  const findingsCount = report.findings_count ?? findings.length;
  const hasCritical = findings.some((f) => f.severity === "critical");
  const tone = isClean ? "ok" : hasCritical ? "danger" : "warn";
  const risk = bom.risk_surface ?? "unknown";
  const capabilityList = Object.entries(bom.capability_count ?? {});

  const severityOrder = ["critical", "high", "medium", "low", "info"];
  const grouped: Record<string, Finding[]> = {};
  for (const f of findings) {
    const sev = f.severity ?? "info";
    (grouped[sev] = grouped[sev] || []).push(f);
  }

  return (
    <details className={`scan-panel scan-panel-${tone}`} open={expanded} onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}>
      <summary className="scan-panel-row">
        <span className="scan-icon" aria-hidden="true">{isClean ? "✓" : "!"}</span>
        <span className="scan-title">
          {isClean
            ? t("scanReport.noIssues")
            : t("scanReport.findingsCount", { count: findingsCount })}
        </span>
        <span className={`scan-risk scan-risk-${risk}`}>{t("scanReport.riskLabel", { risk })}</span>
        {bom.total_files_scanned !== undefined && (
          <span className="scan-hint">{t("scanReport.filesScanned", { count: bom.total_files_scanned })}</span>
        )}
      </summary>
      <div className="scan-panel-body">
        <div className="scan-meta-row">
          {report.scanner_version && (
            <span><strong>{t("scanReport.metaScanner")}</strong> {report.scanner_version}</span>
          )}
          {report.ruleset_version && (
            <span><strong>{t("scanReport.metaRuleset")}</strong> {report.ruleset_version}</span>
          )}
          {report.submitted_at && (
            <span><strong>{t("scanReport.metaScanned")}</strong> {new Date(report.submitted_at).toLocaleString()}</span>
          )}
        </div>
        {capabilityList.length > 0 && (
          <div className="scan-caps">
            <div className="scan-section-label">{t("scanReport.capabilities")}</div>
            <div className="scan-caps-list">
              {capabilityList.map(([cap, count]) => (
                <span key={cap} className="badge scan-cap">
                  {cap} <span className="scan-cap-count">×{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {findings.length > 0 && (
          <div className="scan-findings">
            <div className="scan-section-label">{t("scanReport.findings")}</div>
            {severityOrder
              .filter((sev) => grouped[sev]?.length)
              .map((sev) => (
                <div key={sev} className={`scan-finding-group scan-sev-${sev}`}>
                  <div className="scan-finding-group-head">
                    <span className={`badge scan-sev-badge scan-sev-${sev}`}>{sev}</span>
                    <span className="scan-finding-count">{grouped[sev].length}</span>
                  </div>
                  {grouped[sev].map((f, i) => (
                    <div key={i} className="scan-finding">
                      <div className="scan-finding-msg">{f.message ?? f.rule_id ?? t("scanReport.defaultFindingMsg")}</div>
                      <div className="scan-finding-meta">
                        {f.rule_id && <code>{f.rule_id}</code>}
                        {f.file && <span>{f.file}{f.line ? `:${f.line}` : ""}</span>}
                        {f.classification && f.classification !== "violation" && (
                          <span className="scan-finding-tag">{f.classification}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        )}
        {findings.length === 0 && isClean && (
          <div className="scan-hint">{t("scanReport.cleanHint")}</div>
        )}
      </div>
    </details>
  );
}

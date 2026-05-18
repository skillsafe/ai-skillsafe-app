// Adapt the canonical scanner.ts output to the LocalScanReport envelope
// the desktop UI consumes. Keeps the cloud and offline scan reports
// shape-compatible so ScanReportPanel renders both transparently.

import {
  RULESET_VERSION,
  SCANNER_VERSION,
  scanFiles,
  type FileEntry,
} from "./scanner";
import type { LocalScanReport, ScanInput } from "./types";

export function scanBundle(input: ScanInput): LocalScanReport {
  const files: FileEntry[] = input.files.map((f) => ({
    path: f.path,
    content: f.content,
    size: f.content.length,
  }));
  const result = scanFiles(files);
  const findings = result.raw_findings;
  return {
    scanner_version: SCANNER_VERSION,
    ruleset_version: RULESET_VERSION,
    submitted_at: result.timestamp,
    clean: findings.length === 0,
    findings_count: findings.length,
    findings_summary: JSON.stringify(findings),
    bom_summary: JSON.stringify(result.bom.summary),
    result,
    bom: { risk_surface: result.bom.summary.risk_surface },
  };
}

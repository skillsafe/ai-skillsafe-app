// Offline-scan envelope. Wraps the canonical ScanResult from scanner.ts in
// the same JSON-stringified shape the cloud `ScanReport` uses, so the same
// renderer (ScanReportPanel) handles both. The cloud response packs:
//   findings_summary  — JSON.stringify(<finding[]>)
//   bom_summary       — JSON.stringify(<BOM summary block>)
// We mirror that exactly. The structural `findings` and `bom` fields are
// also exposed for callers (e.g. the ArtifactList badge) that want to read
// the data directly without re-parsing JSON.

import type { RawFinding, ScanResult } from "./scanner";

export type Severity = RawFinding["severity"];
export type RiskSurface = "none" | "low" | "medium" | "high" | "critical";

export interface LocalScanReport {
  scanner_version: string;
  ruleset_version: string;
  submitted_at: string;
  clean: boolean;
  findings_count: number;
  findings_summary: string;
  bom_summary: string;
  /** Canonical scan output, kept for direct consumption. */
  result: ScanResult;
  /** Convenience accessor — mirrors what the cloud envelope exposes. */
  bom: { risk_surface: string };
}

export interface ScanFileInput {
  path: string;
  content: string;
}

export interface ScanInput {
  label: string;
  files: ScanFileInput[];
}

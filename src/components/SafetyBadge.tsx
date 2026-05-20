import type { Severity } from "../lib/feeds/types";

// Shared safety badge. Reuses the .scan-sev-* CSS scale that ScanReportPanel
// already uses for finding severities, and extends it with two SkillSafe-
// specific states ("quarantined", "rewritten") for artifacts whose status
// sentinel is set in frontmatter.
//
// Consumers pass a translated label — the badge stays decoupled from i18n so
// it can be reused by any panel without coordinating new locale keys.

export type SafetyVariant = Severity | "quarantined" | "rewritten";

interface Props {
  variant: SafetyVariant;
  label: string;
  title?: string;
}

export function SafetyBadge({ variant, label, title }: Props) {
  return (
    <span
      className={`badge scan-sev-badge scan-sev-${variant}`}
      title={title ?? label}
    >
      {label}
    </span>
  );
}

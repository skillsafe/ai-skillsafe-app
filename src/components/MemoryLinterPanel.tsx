import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { walkMemorySources, type MemorySource } from "../lib/memory/walker";
import { mergeMemory } from "../lib/memory/merge";
import { findContradictions } from "../lib/memory/contradictions";
import { SafetyBadge } from "./SafetyBadge";
import type { RawFinding } from "../lib/scan/scanner";

interface Props {
  /** Absolute path of the selected memory file — we walk upward from its
   * parent dir. */
  absPath: string;
}

export function MemoryLinterPanel({ absPath }: Props) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<MemorySource[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"sources" | "merged" | "conflicts">("sources");

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      try {
        const startDir = parentDir(absPath);
        if (!startDir) {
          setSources([]);
          return;
        }
        const home = await tauriPaths.homeDir();
        const next = await walkMemorySources(tauriFs, tauriJoiner, {
          startDir,
          homeDir: home,
          maxDepth: 5,
        });
        if (!cancelled) setSources(next);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [absPath]);

  const merged = useMemo(() => mergeMemory(sources), [sources]);
  const conflicts: RawFinding[] = useMemo(() => findContradictions(sources), [sources]);

  if (loading) return <div className="empty">{t("memoryLinter.loading")}</div>;
  if (sources.length === 0) return null;

  return (
    <section className="memory-linter">
      <div className="memory-linter-tabs">
        <button
          type="button"
          className={tab === "sources" ? "active" : ""}
          onClick={() => setTab("sources")}
        >
          {t("memoryLinter.sourcesTab", { count: sources.length })}
        </button>
        <button
          type="button"
          className={tab === "merged" ? "active" : ""}
          onClick={() => setTab("merged")}
        >
          {t("memoryLinter.mergedTab")}
        </button>
        <button
          type="button"
          className={tab === "conflicts" ? "active" : ""}
          onClick={() => setTab("conflicts")}
        >
          {t("memoryLinter.conflictsTab", { count: conflicts.length })}
          {conflicts.length > 0 && (
            <SafetyBadge variant="medium" label={String(conflicts.length)} />
          )}
        </button>
      </div>
      {tab === "sources" && (
        <ul className="memory-linter-sources">
          {sources.map((src) => (
            <li key={src.path}>
              <code>{src.path}</code>
              <span className="muted">
                {" "}
                — {src.tool}, {src.scope}, depth={src.depth}, {src.content.length} chars
              </span>
            </li>
          ))}
        </ul>
      )}
      {tab === "merged" && (
        <pre className="memory-linter-merged">{merged.text}</pre>
      )}
      {tab === "conflicts" && (
        conflicts.length === 0 ? (
          <div className="empty">{t("memoryLinter.noConflicts")}</div>
        ) : (
          <ul className="memory-linter-conflicts">
            {conflicts.map((c, i) => (
              <li key={i}>
                <SafetyBadge variant={c.severity} label={c.rule_id} />
                <div className="memory-linter-conflict-msg">{c.message}</div>
                <code className="muted">{c.file}</code>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}

function parentDir(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx < 0) return null;
  if (idx === 0) return p.length > 1 ? "/" : null;
  return p.slice(0, idx);
}

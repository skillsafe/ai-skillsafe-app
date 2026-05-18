import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/store";
import { prettifyPath } from "./ArtifactList";
import type { MarkdownArtifact } from "../lib/artifacts/types";
import {
  findConflicts,
  matchCandidates,
  type Candidate,
  type Match,
  type Source,
} from "../lib/trigger/matcher";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Maps an artifact's scope to the precedence source used by the matcher.
function sourceFor(a: MarkdownArtifact): Source {
  if (a.scope === "project" || a.scope === "lockfile") return "project";
  if (a.scope === "global") return "global";
  return "unknown";
}

function asCandidate(a: MarkdownArtifact): Candidate {
  return {
    id: a.id,
    name: a.name,
    tool: a.tool,
    source: sourceFor(a),
    projectPath: null,
    description: String(a.frontmatter.description ?? ""),
    path: a.bundleDir ?? a.path,
  };
}

export function TriggerDebuggerDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const { artifacts, remoteArtifacts, masterItems, workbenchInventory, setFocusedArtifactPaths } = useApp();
  const [query, setQuery] = useState("");
  const [toolFilter, setToolFilter] = useState<string>("");
  const [showAllSources, setShowAllSources] = useState(false);

  const candidates: Candidate[] = useMemo(() => {
    // Only real SKILL.md bundles compete for triggering. CLAUDE.md and
    // friends are memory files loaded into the artifact list as synthetic
    // "agent" entries by the tool loaders; filtering them out here keeps
    // them from showing up as bogus same-name conflicts.
    const local = artifacts.filter((a) => a.type === "skill" && a.isBundle).map(asCandidate);

    // Workbench inventory is the cross-tool, cross-scope source of truth
    // for installed skills — pull it in by default so the debugger sees
    // every bundle the user has on disk, not just whichever subset the
    // artifact list happens to be filtered to right now.
    const inv: Candidate[] = (workbenchInventory?.items ?? [])
      .filter((i) => i.category === "skills")
      .map((i) => {
        const payload = i.payload as { frontmatter?: { description?: unknown } } | null;
        return {
          id: `inv:${i.id}`,
          name: i.name,
          tool: i.tool,
          source: i.scope === "project" ? "project" : "global",
          description: String(payload?.frontmatter?.description ?? ""),
          path: i.absPath,
        };
      });

    // Dedup by path so a skill present in both local and inventory only
    // appears once.
    const seenPaths = new Set<string>();
    const dedup = (list: Candidate[]) =>
      list.filter((c) => {
        if (!c.path) return true;
        if (seenPaths.has(c.path)) return false;
        seenPaths.add(c.path);
        return true;
      });
    const base = [...dedup(local), ...dedup(inv)];

    if (!showAllSources) return base;

    const master: Candidate[] = masterItems
      .filter((m) => m.category === "skills")
      .map((m) => {
        const payload = m.payload as { frontmatter?: { description?: unknown } } | null;
        return {
          id: `master:${m.id}`,
          name: m.name,
          tool: m.tool,
          source: "master" as const,
          description: String(payload?.frontmatter?.description ?? ""),
          path: m.absPath,
        };
      });
    const remote: Candidate[] = remoteArtifacts.map((a) => ({
      id: `remote:${a.id}`,
      name: a.name,
      tool: a.tool,
      source: "remote" as const,
      description: String(a.frontmatter.description ?? ""),
    }));
    return [...base, ...dedup(master), ...remote];
  }, [artifacts, remoteArtifacts, masterItems, workbenchInventory, showAllSources]);

  const tools = useMemo(() => {
    const s = new Set<string>();
    for (const c of candidates) s.add(c.tool);
    return Array.from(s).sort();
  }, [candidates]);

  const matches: Match[] = useMemo(() => {
    if (!query.trim()) return [];
    return matchCandidates(query, candidates, { tool: toolFilter || undefined });
  }, [query, candidates, toolFilter]);

  const conflicts = useMemo(() => {
    const pool = toolFilter
      ? candidates.filter((c) => c.tool === toolFilter)
      : candidates;
    return findConflicts(pool).slice(0, 20);
  }, [candidates, toolFilter]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog trigger-debugger-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t("trigger.title")}</h3>
        <p className="dialog-hint">{t("trigger.hint")}</p>

        <div className="form-row">
          <input
            autoFocus
            placeholder={t("trigger.queryPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="trigger-controls">
          <label>
            {t("trigger.toolFilter")}{" "}
            <select value={toolFilter} onChange={(e) => setToolFilter(e.target.value)}>
              <option value="">{t("trigger.allTools")}</option>
              {tools.map((tk) => (
                <option key={tk} value={tk}>{tk}</option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={showAllSources}
              onChange={(e) => setShowAllSources(e.target.checked)}
            />
            {" "}{t("trigger.includeAllSources")}
          </label>
        </div>

        <div className="trigger-section">
          <div className="section-label">
            {t("trigger.matchesLabel", { count: matches.length })}
            <span className="trigger-pool-hint">
              {" "}{t("trigger.poolHint", { count: candidates.length })}
            </span>
          </div>
          {query.trim() === "" ? (
            <div className="trigger-empty">{t("trigger.enterQuery")}</div>
          ) : matches.length === 0 ? (
            <div className="trigger-empty">{t("trigger.noMatches")}</div>
          ) : (
            <table className="trigger-table">
              <thead>
                <tr>
                  <th>{t("trigger.colSkill")}</th>
                  <th>{t("trigger.colTool")}</th>
                  <th>{t("trigger.colSource")}</th>
                  <th>{t("trigger.colScore")}</th>
                  <th>{t("trigger.colMatched")}</th>
                  <th>{t("trigger.colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={m.candidate.id} className={m.shadowedBy ? "trigger-shadowed" : ""}>
                    <td>
                      <code>{m.candidate.name}</code>
                      {m.candidate.path && (
                        <div className="trigger-path" title={m.candidate.path}>
                          {prettifyPath(m.candidate.path)}
                        </div>
                      )}
                    </td>
                    <td>{m.candidate.tool}</td>
                    <td>
                      <span className={`badge source-${m.candidate.source}`}>
                        {m.candidate.source}
                      </span>
                    </td>
                    <td>{(m.score * 100).toFixed(0)}%</td>
                    <td className="trigger-tokens">
                      {m.matchedTokens.map((t) => (
                        <span key={t} className="badge">{t}</span>
                      ))}
                    </td>
                    <td>
                      {m.shadowedBy ? (
                        <span className="badge danger">{t("trigger.shadowed")}</span>
                      ) : matches[0] === m ? (
                        <span className="badge ok">{t("trigger.wouldWin")}</span>
                      ) : (
                        <span className="badge muted">{t("trigger.candidate")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="trigger-section">
          <div className="section-label">
            {t("trigger.conflictsLabel", { count: conflicts.length })}
          </div>
          {conflicts.length === 0 ? (
            <div className="trigger-empty">{t("trigger.noConflicts")}</div>
          ) : (
            <table className="trigger-table">
              <thead>
                <tr>
                  <th>{t("trigger.colA")}</th>
                  <th>{t("trigger.colB")}</th>
                  <th>{t("trigger.colTool")}</th>
                  <th>{t("trigger.colReason")}</th>
                  <th>{t("trigger.colSimilarity")}</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c, i) => (
                  <tr
                    key={i}
                    className="trigger-conflict-row"
                    title={t("trigger.conflictRowTitle")}
                    onClick={() => {
                      const paths = [c.a.path, c.b.path].filter((p): p is string => !!p);
                      if (paths.length > 0) {
                        setFocusedArtifactPaths(paths);
                        onClose();
                      }
                    }}
                  >
                    <td>
                      <code>{c.a.name}</code>
                      {c.a.path && (
                        <div className="trigger-path" title={c.a.path}>
                          {prettifyPath(c.a.path)}
                        </div>
                      )}
                    </td>
                    <td>
                      <code>{c.b.name}</code>
                      {c.b.path && (
                        <div className="trigger-path" title={c.b.path}>
                          {prettifyPath(c.b.path)}
                        </div>
                      )}
                    </td>
                    <td>{c.a.tool}</td>
                    <td>{c.reason === "name" ? t("trigger.reasonName") : t("trigger.reasonDesc")}</td>
                    <td>{(c.similarity * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="dialog-row">
          <button onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}

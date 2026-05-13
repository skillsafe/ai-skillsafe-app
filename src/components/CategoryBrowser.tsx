import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Attachment } from "../lib/artifacts/types";
import { dataTypesFor } from "../lib/backup/dataTypes";
import {
  buildCategoryTreeProgressive,
  resolveCategoryRoots,
  walkCategorySubtree,
  type CategoryRoot,
} from "../lib/category/sources";
import { useApp } from "../lib/store";
import { tauriFs, tauriJoiner, tauriPaths } from "../lib/tauriAdapters";
import { AttachmentTree } from "./AttachmentTree";

// Data-types whose top-level rows we render immediately and whose
// per-row contents are walked only when the user expands them. History &
// Memory typically has dozens of project dirs each with hundreds of
// transcripts — walking them all up front is wasted work.
const LAZY_LOAD_IDS: ReadonlySet<string> = new Set(["memory"]);

// i18n key suffix for a known DataType id. camelCase because the dot in
// `categories.tasks-plans` would be ambiguous inside i18next templates.
function categoryI18nKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function filterTree(nodes: Attachment[], q: string): Attachment[] {
  if (!q) return nodes;
  const needle = q.toLowerCase();
  const out: Attachment[] = [];
  for (const node of nodes) {
    if (node.isDir) {
      const kids = filterTree(node.children ?? [], q);
      if (kids.length > 0 || node.name.toLowerCase().includes(needle)) {
        out.push({ ...node, children: kids });
      }
    } else if (node.name.toLowerCase().includes(needle)) {
      out.push(node);
    }
  }
  return out;
}

export function CategoryBrowser() {
  const { t } = useTranslation();
  const tool = useApp((s) => s.tool);
  const category = useApp((s) => s.category);
  const [roots, setRoots] = useState<CategoryRoot[]>([]);
  const [tree, setTree] = useState<Attachment[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [loadingFolders, setLoadingFolders] = useState<ReadonlySet<string>>(() => new Set());
  // Guard against late updates from a previous load() when the user
  // switches tool/category mid-walk. Each load bumps the token; only the
  // active token's onUpdate calls are accepted into state.
  const activeLoadRef = useRef(0);
  // Tracks per-path lazy-load status across renders. "loading" → in flight,
  // "loaded" → finished (don't re-walk). Reset on every load().
  const lazyStatusRef = useRef(new Map<string, "loading" | "loaded">());

  const dataType = useMemo(
    () => dataTypesFor(tool).find((dt) => dt.id === category) ?? null,
    [tool, category],
  );

  const load = useCallback(async () => {
    if (!dataType) {
      setRoots([]);
      setTree([]);
      return;
    }
    const token = ++activeLoadRef.current;
    lazyStatusRef.current = new Map();
    setLoading(true);
    setStreaming(false);
    setError(null);
    setTree([]);
    setLoadingFolders(new Set());
    try {
      const resolved = await resolveCategoryRoots(
        tauriFs,
        tool,
        dataType,
        tauriPaths,
        tauriJoiner,
      );
      if (activeLoadRef.current !== token) return;
      setRoots(resolved);
      if (resolved.length === 0) {
        setLoading(false);
        return;
      }
      setLoading(false);
      // Lazy mode: render the resolved roots as collapsed empty folders
      // and stop. Each folder's contents are walked when the user opens
      // it (see handleExpandFolder below).
      if (LAZY_LOAD_IDS.has(dataType.id)) {
        const shallow: Attachment[] = resolved.map((r) =>
          r.isFile
            ? { name: r.name, path: r.path, size: 0, isDir: false }
            : { name: r.name, path: r.path, size: 0, isDir: true, children: [] },
        );
        setTree(shallow);
        return;
      }
      // Streaming mode for everything else — walks the full tree in the
      // background and re-renders as each root settles.
      setStreaming(true);
      await buildCategoryTreeProgressive(
        tauriFs,
        tauriJoiner,
        resolved,
        dataType.id,
        (next) => {
          if (activeLoadRef.current !== token) return;
          setTree(next);
        },
      );
      if (activeLoadRef.current !== token) return;
      setStreaming(false);
    } catch (e) {
      if (activeLoadRef.current !== token) return;
      setError(e instanceof Error ? e.message : String(e));
      setRoots([]);
      setTree([]);
      setLoading(false);
      setStreaming(false);
    }
  }, [tool, dataType]);

  // Replace the subtree rooted at `path` with new children. Walks the
  // existing tree depth-first and rebuilds only the affected branch so
  // React sees a fresh reference to re-render that subtree.
  const replaceChildren = useCallback(
    (nodes: Attachment[], path: string, children: Attachment[]): Attachment[] => {
      return nodes.map((n) => {
        if (n.path === path && n.isDir) {
          return { ...n, children };
        }
        if (n.isDir && n.children && n.children.length > 0) {
          return { ...n, children: replaceChildren(n.children, path, children) };
        }
        return n;
      });
    },
    [],
  );

  const handleExpandFolder = useCallback(
    async (node: Attachment) => {
      if (!dataType || !node.isDir) return;
      if (!LAZY_LOAD_IDS.has(dataType.id)) return;
      const status = lazyStatusRef.current.get(node.path);
      if (status === "loading" || status === "loaded") return;
      lazyStatusRef.current.set(node.path, "loading");
      setLoadingFolders((prev) => {
        const next = new Set(prev);
        next.add(node.path);
        return next;
      });
      const token = activeLoadRef.current;
      try {
        const kids = await walkCategorySubtree(
          tauriFs,
          tauriJoiner,
          node.path,
          dataType.id,
        );
        if (activeLoadRef.current !== token) return;
        lazyStatusRef.current.set(node.path, "loaded");
        setTree((prev) => replaceChildren(prev, node.path, kids));
      } catch (e) {
        if (activeLoadRef.current !== token) return;
        lazyStatusRef.current.delete(node.path);
        console.error("Failed to walk subtree:", node.path, e);
      } finally {
        if (activeLoadRef.current === token) {
          setLoadingFolders((prev) => {
            const next = new Set(prev);
            next.delete(node.path);
            return next;
          });
        }
      }
    },
    [dataType, replaceChildren],
  );

  useEffect(() => {
    void load();
  }, [load, reloadTick]);

  const filtered = useMemo(() => filterTree(tree, query.trim()), [tree, query]);
  const label = dataType
    ? t(`categories.${categoryI18nKey(dataType.id)}`, { defaultValue: dataType.label })
    : "";

  return (
    <section className="list-pane">
      <div className="list-toolbar">
        <input
          className="search"
          placeholder={t("artifactList.filterPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          onClick={() => setReloadTick((n) => n + 1)}
          aria-label={t("artifactList.reloadAria")}
          title={t("artifactList.reloadTitle")}
        >
          ↻
        </button>
      </div>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontWeight: 600 }}>
          {label}
          {streaming && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                color: "var(--muted)",
                fontWeight: 400,
              }}
            >
              {t("categories.streaming", { defaultValue: "Loading files…" })}
            </span>
          )}
        </div>
        {dataType?.description && (
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {dataType.description}
          </div>
        )}
      </div>
      {error ? (
        <div className="empty">
          <div className="empty-error">{error}</div>
        </div>
      ) : loading ? (
        <div className="empty">{t("artifactList.loading", { defaultValue: "Loading…" })}</div>
      ) : roots.length === 0 ? (
        <div className="empty">
          {t("categories.noFilesFound")}
          <div className="empty-error" style={{ marginTop: 6, fontSize: 12 }}>
            {t("categories.emptyHint", { label })}
          </div>
        </div>
      ) : (
        <div style={{ padding: "8px 4px" }}>
          <AttachmentTree
            attachments={filtered}
            defaultExpanded={false}
            onExpandFolder={handleExpandFolder}
            loadingFolders={loadingFolders}
          />
        </div>
      )}
    </section>
  );
}

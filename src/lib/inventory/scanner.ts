// Inventory scanner — walks each tool's StateSurface entries and returns
// a flat list of items found on disk. Best-effort: a single failing
// surface or unreadable path is logged on the snapshot's `errors` map but
// never aborts the whole scan.

import type { FsAdapter } from "../fs";
import type { PathResolverDeps } from "../paths";
import {
  surfacesFor,
  toolsWithSurfaces,
  type StateSurface,
  type SurfaceContext,
} from "../agents/state";
import type { InventoryItem, InventorySnapshot, WorkbenchScope } from "./types";

export interface ScanOptions {
  fs: FsAdapter;
  paths: PathResolverDeps;
  /** Tools to scan. Defaults to every tool with at least one surface. */
  tools?: string[];
  /**
   * Scopes to include. Project scope requires `projectRoots`; surfaces with
   * no candidate paths in the requested scope just contribute nothing.
   */
  scopes?: WorkbenchScope[];
  /** Project roots to scan in project scope. Empty = skip project scope. */
  projectRoots?: string[];
}

export async function scanInventory(opts: ScanOptions): Promise<InventorySnapshot> {
  const tools = opts.tools ?? toolsWithSurfaces();
  const scopes = opts.scopes ?? ["global", "project"];
  const projectRoots = opts.projectRoots ?? [];
  const items: InventoryItem[] = [];
  const errors: Record<string, string> = {};
  const seen = new Set<string>();

  for (const tool of tools) {
    const surfaces = surfacesFor(tool);
    if (surfaces.length === 0) continue;
    try {
      for (const surface of surfaces) {
        if (!scopes.includes(surface.scope)) continue;
        const targetRoots: Array<string | undefined> =
          surface.scope === "project" ? projectRoots : [undefined];
        if (surface.scope === "project" && targetRoots.length === 0) continue;
        for (const projectRoot of targetRoots) {
          const ctx: SurfaceContext = {
            fs: opts.fs,
            paths: opts.paths,
            scope: surface.scope,
            projectRoot,
          };
          await collectFromSurface(surface, ctx, items, seen, tool, errors);
        }
      }
    } catch (e) {
      errors[tool] = errorMessage(e);
    }
  }

  return {
    generatedAt: Date.now(),
    items,
    scannedTools: tools,
    errors,
  };
}

async function collectFromSurface(
  surface: StateSurface,
  ctx: SurfaceContext,
  out: InventoryItem[],
  seen: Set<string>,
  tool: string,
  errors: Record<string, string>,
): Promise<void> {
  let candidatePaths: string[];
  try {
    candidatePaths = await surface.paths(ctx);
  } catch (e) {
    errors[`${tool}:${surface.category}:${surface.scope}`] = errorMessage(e);
    return;
  }
  for (const path of candidatePaths) {
    try {
      const items = await surface.read(ctx, path);
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    } catch (e) {
      // Per-path failure: record once per (tool,category,scope,path) and
      // continue. The surface-level errors map intentionally collapses
      // multiple path failures under a single key — Workbench shows the
      // first error and the user can investigate.
      const key = `${tool}:${surface.category}:${surface.scope}:${path}`;
      errors[key] = errorMessage(e);
    }
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function groupByCategory(items: InventoryItem[]): Map<string, InventoryItem[]> {
  const out = new Map<string, InventoryItem[]>();
  for (const it of items) {
    const arr = out.get(it.category) ?? [];
    arr.push(it);
    out.set(it.category, arr);
  }
  return out;
}

export function groupByTool(items: InventoryItem[]): Map<string, InventoryItem[]> {
  const out = new Map<string, InventoryItem[]>();
  for (const it of items) {
    const arr = out.get(it.tool) ?? [];
    arr.push(it);
    out.set(it.tool, arr);
  }
  return out;
}

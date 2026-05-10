// Owns the Workbench view's "scan everything" effect: cross-tool inventory
// + master-folder manifest + master-folder file walk. Lifted out of
// InventoryList so the right-pane Workbench doesn't depend on the list pane
// having mounted to populate the store.

import { useEffect, useMemo, useRef } from "react";
import { useApp } from "../store";
import { isInstalled } from "../agents/detect";
import { tauriFs, tauriJoiner, tauriPaths } from "../tauriAdapters";
import { scanInventory } from "../inventory/scanner";
import { toolsWithSurfaces } from "../agents/state";
import { listMasterItems, loadManifest, resolveMasterRoot } from "../master/store";

export function useWorkbenchData() {
  const view = useApp((s) => s.view);
  const recentProjects = useApp((s) => s.recentProjects);
  const projectFilter = useApp((s) => s.projectFilter);
  const masterRoot = useApp((s) => s.masterRoot);
  const backupDestination = useApp((s) => s.backupDestination);
  const scanNonce = useApp((s) => s.workbenchScanNonce);
  const setInventory = useApp((s) => s.setWorkbenchInventory);
  const setLoading = useApp((s) => s.setWorkbenchLoading);
  const setError = useApp((s) => s.setWorkbenchError);
  const setInstalled = useApp((s) => s.setWorkbenchInstalled);
  const setMasterManifest = useApp((s) => s.setMasterManifest);
  const setMasterRootResolved = useApp((s) => s.setMasterRootResolved);
  const setMasterItems = useApp((s) => s.setMasterItems);

  const projectRoots = useMemo(() => {
    if (projectFilter && recentProjects.includes(projectFilter)) return [projectFilter];
    return recentProjects;
  }, [recentProjects, projectFilter]);

  const genRef = useRef(0);

  useEffect(() => {
    if (view !== "workbench") return;
    let cancelled = false;
    const myGen = ++genRef.current;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const tools = toolsWithSurfaces();
        const installedEntries = await Promise.all(
          tools.map(async (t) => [t, await isInstalled(tauriFs, tauriPaths, t)] as const),
        );
        const resolvedRoot = await resolveMasterRoot(tauriPaths, masterRoot, backupDestination);
        const [snap, manifest] = await Promise.all([
          scanInventory({
            fs: tauriFs,
            paths: tauriPaths,
            tools,
            scopes: ["global", "project"],
            projectRoots,
          }),
          loadManifest(tauriFs, tauriJoiner, resolvedRoot),
        ]);
        if (cancelled || myGen !== genRef.current) return;
        const masterFolderItems = await listMasterItems(
          tauriFs,
          tauriJoiner,
          resolvedRoot,
          manifest,
        );
        if (cancelled || myGen !== genRef.current) return;
        const installedMap: Record<string, boolean> = {};
        for (const [t, ok] of installedEntries) installedMap[t] = ok;
        setInstalled(installedMap);
        setInventory(snap);
        setMasterManifest(manifest);
        setMasterItems(masterFolderItems);
        setMasterRootResolved(resolvedRoot);
      } catch (e) {
        if (cancelled || myGen !== genRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled && myGen === genRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    view,
    projectRoots,
    masterRoot,
    backupDestination,
    scanNonce,
    setInventory,
    setLoading,
    setError,
    setInstalled,
    setMasterManifest,
    setMasterItems,
    setMasterRootResolved,
  ]);
}

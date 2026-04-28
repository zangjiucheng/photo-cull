import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWorkspaceLibrary, openWorkspace, refreshLibrary, rescoreWorkspace, restorePhotos } from "../api";
import { normalizeScores } from "../core";
import type { LibraryFolder, LibraryPayload, Photo, PhotoWorkspace, StatusTone } from "../types";

export function useLibrary(updateStatus: (text: string, tone?: StatusTone) => void) {
  const [workspaces, setWorkspaces] = useState<PhotoWorkspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [processingCount, setProcessingCount] = useState(0);
  const [excludedCount, setExcludedCount] = useState(0);
  const [indexing, setIndexing] = useState<NonNullable<LibraryPayload["summary"]["indexing"]>>({
    active: false,
    indexed: 0,
    totalDiscovered: 0,
    status: "idle",
    startedAt: null,
    finishedAt: null,
    error: null
  });
  const [isLibraryReady, setIsLibraryReady] = useState(false);
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const observerRefreshTimer = useRef<number | null>(null);
  const [activeFolderByWorkspace, setActiveFolderByWorkspace] = useState<Record<string, string>>({});
  const [activeIdByWorkspace, setActiveIdByWorkspace] = useState<Record<string, string | null>>({});

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const activeFolderPath = activeWorkspaceId ? activeFolderByWorkspace[activeWorkspaceId] ?? "" : "";
  const activeId = activeWorkspaceId ? activeIdByWorkspace[activeWorkspaceId] ?? null : null;

  const setActiveWorkspaceId = useCallback((workspaceId: string | null) => {
    setActiveWorkspaceIdState(workspaceId);
  }, []);

  const setActiveFolderPath = useCallback((folderPath: string) => {
    if (!activeWorkspaceId) return;
    setActiveFolderByWorkspace((current) => ({ ...current, [activeWorkspaceId]: folderPath }));
  }, [activeWorkspaceId]);

  const setActiveId = useCallback((photoId: string | null) => {
    if (!activeWorkspaceId) return;
    setActiveIdByWorkspace((current) => ({ ...current, [activeWorkspaceId]: photoId }));
  }, [activeWorkspaceId]);

  const applyLibraryPayload = useCallback((data: LibraryPayload) => {
    const normalized = normalizeScores(data.photos);
    const nextWorkspaceId = data.activeWorkspace?.id ?? null;

    setWorkspaces(data.workspaces);
    setPhotos(normalized);
    setFolders(data.folders);
    setPendingCount(data.summary.pending);
    setProcessingCount(data.summary.processing);
    setExcludedCount(data.summary.excluded ?? 0);
    setIndexing(data.summary.indexing ?? {
      active: false,
      indexed: 0,
      totalDiscovered: 0,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null
    });
    setActiveWorkspaceId(nextWorkspaceId);

    if (nextWorkspaceId) {
      setActiveFolderByWorkspace((current) => {
        const currentFolder = current[nextWorkspaceId] ?? "";
        if (currentFolder === "" || data.folders.some((folder) => folder.path === currentFolder)) {
          return current;
        }
        return { ...current, [nextWorkspaceId]: data.folders[0]?.path || "" };
      });
      setActiveIdByWorkspace((current) => {
        const currentId = current[nextWorkspaceId];
        if (currentId && normalized.some((photo) => photo.id === currentId)) {
          return current;
        }
        return { ...current, [nextWorkspaceId]: normalized[0]?.id || null };
      });
    }

    const scoreMode = data.summary.scoreMode ? ` using ${data.summary.scoreMode}` : "";
    if (!nextWorkspaceId) {
      updateStatus("Open a folder to create a workspace.", "warn");
    } else if (data.summary.indexing?.active) {
      updateStatus(`Indexing workspace: ${data.summary.indexing.indexed} file(s) processed`, "busy");
    } else if (data.summary.processing > 0 || data.summary.pending > 0) {
      updateStatus(
        `Scoring in background${scoreMode}: ${data.summary.processing} processing, ${data.summary.pending} queued`,
        "busy"
      );
    } else if (data.summary.error > 0) {
      updateStatus(`Loaded ${normalized.length} photos (${data.summary.error} failed).`, "warn");
    } else {
      updateStatus(`Loaded ${normalized.length} photos${scoreMode}.`, "ok");
    }
  }, [setActiveWorkspaceId, updateStatus]);

  const loadLibrary = useCallback(async (workspaceId = activeWorkspaceId) => {
    setIsLibraryLoading(true);
    try {
      applyLibraryPayload(await fetchWorkspaceLibrary(workspaceId));
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to load library", "error");
    } finally {
      setIsLibraryReady(true);
      setIsLibraryLoading(false);
    }
  }, [activeWorkspaceId, applyLibraryPayload, updateStatus]);

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) {
      updateStatus("Open a folder before refreshing.", "warn");
      return;
    }
    const data = await refreshLibrary(activeWorkspaceId);
    applyLibraryPayload(data);
    return data;
  }, [activeWorkspaceId, applyLibraryPayload, updateStatus]);

  const refreshScores = useCallback(async () => {
    if (!activeWorkspaceId) {
      updateStatus("Open a workspace before refreshing AI scores.", "warn");
      return;
    }
    const data = await rescoreWorkspace(activeWorkspaceId);
    applyLibraryPayload(data);
    return data;
  }, [activeWorkspaceId, applyLibraryPayload, updateStatus]);

  const openFolderWorkspace = useCallback(async (rootPath: string) => {
    const workspace = await openWorkspace(rootPath);
    setActiveWorkspaceId(workspace.id);
    await loadLibrary(workspace.id);
    return workspace;
  }, [loadLibrary, setActiveWorkspaceId]);

  const restoreRemoved = useCallback(async () => {
    if (!activeWorkspaceId) {
      updateStatus("Open a workspace before restoring removed photos.", "warn");
      return;
    }
    const result = await restorePhotos(activeWorkspaceId);
    await loadLibrary(activeWorkspaceId);
    updateStatus(`Restored ${result.restored} removed photo(s).`, result.restored ? "ok" : "warn");
  }, [activeWorkspaceId, loadLibrary, updateStatus]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (!indexing.active && pendingCount === 0 && processingCount === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadLibrary();
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadLibrary, indexing.active, pendingCount, processingCount]);

  useEffect(() => {
    if (!activeWorkspaceId || typeof EventSource === "undefined") {
      return undefined;
    }
    const source = new EventSource(`/api/events?workspace_id=${encodeURIComponent(activeWorkspaceId)}`);
    const scheduleRefresh = () => {
      if (observerRefreshTimer.current !== null) {
        return;
      }
      observerRefreshTimer.current = window.setTimeout(() => {
        observerRefreshTimer.current = null;
        void loadLibrary(activeWorkspaceId);
      }, 150);
    };
    source.addEventListener("library:update", scheduleRefresh);
    return () => {
      source.close();
      if (observerRefreshTimer.current !== null) {
        window.clearTimeout(observerRefreshTimer.current);
        observerRefreshTimer.current = null;
      }
    };
  }, [activeWorkspaceId, loadLibrary]);

  return {
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    setActiveWorkspaceId,
    photos,
    folders,
    pendingCount,
    processingCount,
    indexing,
    excludedCount,
    isLibraryReady,
    isLibraryLoading,
    activeFolderPath,
    setActiveFolderPath,
    activeId,
    setActiveId,
    loadLibrary,
    refresh,
    refreshScores,
    openFolderWorkspace,
    restoreRemoved
  };
}

import { useCallback, useEffect, useState } from "react";
import { fetchLibrary, refreshLibrary } from "../api";
import { normalizeScores } from "../core";
import type { LibraryFolder, LibraryPayload, Photo, StatusTone } from "../types";

export function useLibrary(updateStatus: (text: string, tone?: StatusTone) => void) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [processingCount, setProcessingCount] = useState(0);
  const [activeFolderPath, setActiveFolderPath] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const applyLibraryPayload = useCallback((data: LibraryPayload) => {
    const normalized = normalizeScores(data.photos);
    setPhotos(normalized);
    setFolders(data.folders);
    setPendingCount(data.summary.pending);
    setProcessingCount(data.summary.processing);
    setActiveFolderPath((current) => {
      if (current && data.folders.some((folder) => folder.path === current)) {
        return current;
      }
      return data.folders[0]?.path || "";
    });
    setActiveId((current) => current || normalized[0]?.id || null);

    const scoreMode = data.summary.scoreMode ? ` using ${data.summary.scoreMode}` : "";
    if (data.summary.processing > 0 || data.summary.pending > 0) {
      updateStatus(
        `Scoring in background${scoreMode}: ${data.summary.processing} processing, ${data.summary.pending} queued`,
        "busy"
      );
    } else if (data.summary.error > 0) {
      updateStatus(`Loaded ${normalized.length} photos (${data.summary.error} failed).`, "warn");
    } else {
      updateStatus(`Loaded ${normalized.length} photos from uploads${scoreMode}.`, "ok");
    }
  }, [updateStatus]);

  const loadLibrary = useCallback(async () => {
    try {
      applyLibraryPayload(await fetchLibrary());
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to load library", "error");
    }
  }, [applyLibraryPayload, updateStatus]);

  const refresh = useCallback(async () => {
    const data = await refreshLibrary();
    applyLibraryPayload(data);
  }, [applyLibraryPayload]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (pendingCount === 0 && processingCount === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadLibrary();
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadLibrary, pendingCount, processingCount]);

  return {
    photos,
    folders,
    pendingCount,
    processingCount,
    activeFolderPath,
    setActiveFolderPath,
    activeId,
    setActiveId,
    loadLibrary,
    refresh
  };
}

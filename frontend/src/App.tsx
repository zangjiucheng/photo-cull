import { useCallback, useEffect, useMemo, useState } from "react";
import { deletePhotos, exportPhotos, findSimilarPhotos, updatePhotoOrientation, updatePhotoRating, updatePhotoScore } from "./api";
import { FolderNavigator } from "./components/library/FolderNavigator";
import { InspectorPanel } from "./components/library/InspectorPanel";
import { BrowseWorkspace } from "./components/workspaces/BrowseWorkspace";
import { DuplicatesWorkspace } from "./components/workspaces/DuplicatesWorkspace";
import { ExportWorkspace } from "./components/workspaces/ExportWorkspace";
import { ReviewWorkspace } from "./components/workspaces/ReviewWorkspace";
import { WorkspaceLauncher } from "./components/workspaces/WorkspaceLauncher";
import { StatsWorkspace } from "./components/workspaces/StatsWorkspace";
import { WorkspaceShell } from "./components/workspaces/WorkspaceShell";
import { useLibrary } from "./hooks/useLibrary";
import { usePhotoFilters } from "./hooks/usePhotoFilters";
import { usePhotoRatings } from "./hooks/usePhotoRatings";
import { ShortcutHelpDialog } from "./shortcuts/ShortcutHelpDialog";
import { shortcutRegistry } from "./shortcuts/registry";
import type { ShortcutHandlers, ShortcutScope } from "./shortcuts/types";
import { useShortcuts } from "./shortcuts/useShortcuts";
import type { LibraryFolder, Photo, RatingFilter, SimilarGroup, SimilarPayload, SortMode, StatusTone, ViewMode, WorkspaceTab } from "./types";

const NEW_WORKSPACE_FROM_FOLDER_VALUE = "__new_workspace_from_folder__";

interface SimilarityProgress {
  percent: number;
  label: string;
  detail: string;
}

function formatFolderLabel(folder: LibraryFolder): string {
  return folder.path ? folder.path : "Root";
}

export default function App() {
  const [search, setSearch] = useState("");
  const [minScore, setMinScore] = useState(70);
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortMode, setSortMode] = useState<SortMode>("score-desc");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("browse");
  const [statusText, setStatusText] = useState("Ready");
  const [statusTone, setStatusTone] = useState<StatusTone>("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRescoring, setIsRescoring] = useState(false);
  const [exportQueues, setExportQueues] = useState<Record<string, string[]>>({});
  const [similarGroups, setSimilarGroups] = useState<SimilarGroup[]>([]);
  const [similarDeleteIds, setSimilarDeleteIds] = useState<Set<string>>(new Set());
  const [isFindingSimilar, setIsFindingSimilar] = useState(false);
  const [isDeletingSimilar, setIsDeletingSimilar] = useState(false);
  const [similarityProgress, setSimilarityProgress] = useState<SimilarityProgress | null>(null);
  const [openPreviewSignal, setOpenPreviewSignal] = useState(0);
  const [isInspectorPreviewOpen, setIsInspectorPreviewOpen] = useState(false);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);

  const updateStatus = useCallback((text: string, tone: StatusTone = "") => {
    setStatusText(text);
    setStatusTone(tone);
  }, []);

  const library = useLibrary(updateStatus);
  const {
    photos,
    folders,
    activeFolderPath,
    setActiveFolderPath,
    activeId,
    setActiveId,
    loadLibrary,
    refresh,
    activateWorkspace,
    refreshScores,
    activeWorkspace,
    activeWorkspaceId,
    openFolderWorkspace,
    restoreRemoved,
    excludedCount
  } = library;
  const ratingState = usePhotoRatings(photos, updateStatus);
  const { ratings, setRatings, ratePhoto } = ratingState;
  const { activeFolder, folderPhotos, visiblePhotos, activePhoto } = usePhotoFilters(photos, folders, {
    activeFolderPath,
    search,
    minScore,
    ratingFilter,
    sortMode,
    ratings,
    activeId
  });

  const keepRate = folderPhotos.length ? Math.round((visiblePhotos.length / folderPhotos.length) * 100) : 0;
  const ratedCount = ratings.size;
  const fourPlusIds = photos.filter((photo) => (ratings.get(photo.id) ?? photo.rating ?? 0) >= 4).map((photo) => photo.id);
  const exportQueueIds = useMemo(() => new Set(activeWorkspaceId ? exportQueues[activeWorkspaceId] ?? [] : []), [activeWorkspaceId, exportQueues]);
  const exportQueueList = useMemo(() => Array.from(exportQueueIds), [exportQueueIds]);
  const similarNavigation = useMemo(() => {
    if (activeTab !== "duplicates" || !activePhoto) {
      return null;
    }
    for (const [groupIndex, group] of similarGroups.entries()) {
      const photoIndex = group.photos.findIndex((photo) => photo.id === activePhoto.id);
      if (photoIndex === -1) {
        continue;
      }
      return {
        current: photoIndex + 1,
        total: group.photos.length,
        groupLabel: `Group ${groupIndex + 1}`,
        previousId: photoIndex > 0 ? group.photos[photoIndex - 1].id : null,
        nextId: photoIndex < group.photos.length - 1 ? group.photos[photoIndex + 1].id : null,
        canRemove: activePhoto.id !== group.keepPhotoId,
        isMarkedForRemoval: similarDeleteIds.has(activePhoto.id)
      };
    }
    return null;
  }, [activePhoto, activeTab, similarDeleteIds, similarGroups]);

  const applySimilarPayload = useCallback((payload: SimilarPayload) => {
    const photoMap = new Map(photos.map((photo) => [photo.id, photo]));
    const groups = payload.groups
      .map((group) => ({
        id: group.id,
        stage: group.stage,
        tier: group.tier,
        keepPhotoId: group.keepPhotoId,
        maxDistance: group.maxDistance,
        maxSimilarity: group.maxSimilarity,
        candidates: group.candidates,
        photos: group.photoIds
          .map((id) => photoMap.get(id))
          .filter((photo): photo is Photo => Boolean(photo))
      }))
      .filter((group) => group.photos.length > 1);
    setSimilarGroups(groups);
    setSimilarDeleteIds(new Set(groups.flatMap((group) => group.candidates.filter((candidate) => candidate.deleteRecommended).map((candidate) => candidate.photoId))));
    return groups;
  }, [photos]);
  const reviewRate = photos.length ? Math.round((ratedCount / photos.length) * 100) : 0;
  const completedCount = photos.filter((p) => p.status === "done" || p.status === "error").length;
  const processingTotal = photos.length;
  const processingInFlight = library.pendingCount + library.processingCount;
  const processingProgress = processingTotal
    ? Math.max(0, Math.min(100, Math.round((completedCount / processingTotal) * 100)))
    : 0;
  const indexingTotal = Math.max(library.indexing.totalDiscovered, library.indexing.indexed, 0);
  const backgroundProgress = library.indexing.active
    ? {
        title: "Background indexing",
        state: "active" as const,
        detail: "Indexing workspace",
        completed: library.indexing.indexed,
        pending: Math.max(indexingTotal - library.indexing.indexed, 0),
        processing: 0,
        total: indexingTotal || 1,
        percent: indexingTotal ? Math.max(0, Math.min(100, Math.round((library.indexing.indexed / indexingTotal) * 100))) : 0
      }
    : {
        title: "Background scoring",
        state: (library.indexing.status === "error" ? "error" : processingInFlight > 0 ? "active" : "idle") as "active" | "idle" | "error",
        detail: library.indexing.status === "error" ? (library.indexing.error || "Indexing failed") : processingInFlight > 0 ? "Scoring in background" : "Idle",
        completed: completedCount,
        pending: library.pendingCount,
        processing: library.processingCount,
        total: processingTotal,
        percent: processingProgress
      };

  const toggleExportQueue = useCallback((id: string) => {
    if (!activeWorkspaceId) return;
    setExportQueues((prev) => {
      const next = new Set(prev[activeWorkspaceId] ?? []);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { ...prev, [activeWorkspaceId]: Array.from(next) };
    });
  }, [activeWorkspaceId]);

  function addToExportQueue(id: string) {
    if (!activeWorkspaceId) return;
    setExportQueues((prev) => ({ ...prev, [activeWorkspaceId]: Array.from(new Set([...(prev[activeWorkspaceId] ?? []), id])) }));
    updateStatus("Added photo to export queue.", "ok");
  }

  function addVisibleToQueue() {
    if (!visiblePhotos.length) {
      updateStatus("No visible photos to add.", "warn");
      return;
    }
    if (!activeWorkspaceId) return;
    setExportQueues((prev) => {
      const next = new Set(prev[activeWorkspaceId] ?? []);
      for (const photo of visiblePhotos) {
        next.add(photo.id);
      }
      return { ...prev, [activeWorkspaceId]: Array.from(next) };
    });
    updateStatus(`Added ${visiblePhotos.length} visible photo(s) to export queue.`, "ok");
  }

  function removeFromExportQueue(id: string) {
    if (!activeWorkspaceId) return;
    setExportQueues((prev) => {
      const next = new Set(prev[activeWorkspaceId] ?? []);
      next.delete(id);
      return { ...prev, [activeWorkspaceId]: Array.from(next) };
    });
  }

  async function onOpenFolder() {
    updateStatus("Opening folder...", "busy");
    try {
      const selectedPath = window.aiCulling?.openFolder
        ? await window.aiCulling.openFolder()
        : window.prompt("Enter a folder path on this machine");
      if (!selectedPath) {
        updateStatus("Open folder cancelled.", "warn");
        return;
      }
      const workspace = await openFolderWorkspace(selectedPath);
      updateStatus(`Opened ${workspace.name}.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to open folder", "error");
    }
  }

  async function onOpenWorkspaceFile() {
    updateStatus("Opening workspace file...", "busy");
    try {
      const selectedPath = window.aiCulling?.openWorkspaceFile
        ? await window.aiCulling.openWorkspaceFile()
        : window.prompt("Enter the workspace folder path referenced by the workspace file");
      if (!selectedPath) {
        updateStatus("Open workspace file cancelled.", "warn");
        return;
      }
      const workspace = await openFolderWorkspace(selectedPath);
      updateStatus(`Opened ${workspace.name}.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to open workspace file", "error");
    }
  }

  const onSaveWorkspaceFile = useCallback(async () => {
    if (!activeWorkspace) {
      updateStatus("Open a workspace before saving a workspace file.", "warn");
      return;
    }
    if (!window.aiCulling?.saveWorkspaceFile) {
      updateStatus("Saving workspace files is only available in the desktop app.", "warn");
      return;
    }

    updateStatus("Saving workspace file...", "busy");
    try {
      const savedPath = await window.aiCulling.saveWorkspaceFile({
        name: activeWorkspace.name,
        rootPath: activeWorkspace.rootPath
      });
      if (!savedPath) {
        updateStatus("Save workspace file cancelled.", "warn");
        return;
      }
      updateStatus(`Saved workspace file to ${savedPath}.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to save workspace file", "error");
    }
  }, [activeWorkspace, updateStatus]);

  useEffect(() => {
    if (!window.aiCulling?.onSaveWorkspaceFileRequest) {
      return undefined;
    }
    return window.aiCulling.onSaveWorkspaceFileRequest(() => {
      void onSaveWorkspaceFile();
    });
  }, [onSaveWorkspaceFile]);

  async function onRevealWorkspaceFolder() {
    if (!activeWorkspace) {
      updateStatus("Open a workspace first.", "warn");
      return;
    }
    if (!window.aiCulling?.revealFolder) {
      updateStatus("Finder reveal is only available in the desktop app.", "warn");
      return;
    }
    updateStatus("Opening workspace folder...", "busy");
    try {
      await window.aiCulling.revealFolder(activeWorkspace.rootPath);
      updateStatus(`Opened ${activeWorkspace.name} in Finder.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to open folder in Finder", "error");
    }
  }

  async function saveScoreOverride(id: string, manualScore: number | null) {
    try {
      await updatePhotoScore(id, manualScore);
      await loadLibrary(activeWorkspaceId);
      updateStatus(manualScore === null ? "Manual score removed." : `Manual score set to ${manualScore}.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to update score", "error");
      throw err;
    }
  }

  function scoreToRating(score: number) {
    if (score >= 90) return 5;
    if (score >= 78) return 4;
    if (score >= 62) return 3;
    if (score >= 42) return 2;
    return 1;
  }

  function onAutoRateByScore() {
    if (!folderPhotos.length) {
      updateStatus("Open a folder with photos before running AI Rate.", "warn");
      return;
    }

    const targetIds = new Set(folderPhotos.map((photo) => photo.id));
    const nextRatings = new Map(folderPhotos.map((photo) => [photo.id, scoreToRating(photo.aiScore)]));

    const previousRatings = new Map(ratings);

    setRatings((prev) => {
      const next = new Map(prev);
      for (const id of targetIds) {
        next.delete(id);
      }
      for (const [id, rating] of nextRatings) {
        next.set(id, rating);
      }
      return next;
    });

    void Promise.allSettled(
      folderPhotos.map((photo) =>
        updatePhotoRating(photo.id, nextRatings.get(photo.id) ?? null)
      )
    ).then((results) => {
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) {
        setRatings(previousRatings);
        updateStatus(`AI Rate failed to save ${failed} rating(s).`, "error");
        return;
      }
      updateStatus(`AI Rate assigned stars to ${folderPhotos.length} photo(s).`, "ok");
    });
  }

  async function onExport() {
    if (!exportQueueList.length) {
      updateStatus("Add photos to the export queue before exporting.", "warn");
      return;
    }

    updateStatus("Building ZIP export...", "busy");
    try {
      const blob = await exportPhotos(exportQueueList);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "selected.zip";
      a.click();
      window.URL.revokeObjectURL(url);
      updateStatus(`Exported ${exportQueueList.length} queued photo(s).`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Export failed", "error");
    }
  }

  async function onRefresh() {
    updateStatus("Refreshing active workspace...", "busy");
    setIsRefreshing(true);
    try {
      const data = await refresh();
      if (data?.summary.indexing?.active) {
        updateStatus(`Indexing workspace: ${data.summary.indexing.indexed} file(s) processed`, "busy");
      } else {
        updateStatus("Refresh complete.", "ok");
      }
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Refresh failed", "error");
    } finally {
      setIsRefreshing(false);
    }
  }

  async function onRefreshScores() {
    if (!photos.length) {
      updateStatus("No photos to rescore.", "warn");
      return;
    }
    const confirmed = window.confirm(`Refresh AI scores for all ${photos.length} photo(s) in this workspace? Manual overrides and stars will stay.`);
    if (!confirmed) {
      return;
    }

    updateStatus("Refreshing all AI scores...", "busy");
    setIsRescoring(true);
    try {
      const payload = await refreshScores();
      updateStatus(`Queued ${payload?.rescore?.queued ?? photos.length} photo(s) for AI scoring.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to refresh AI scores", "error");
    } finally {
      setIsRescoring(false);
    }
  }

  async function saveOrientationOverride(id: string, orientationOverride: 0 | 90 | 180 | 270 | null) {
    try {
      await updatePhotoOrientation(id, orientationOverride);
      await loadLibrary(activeWorkspaceId);
      updateStatus(orientationOverride === null ? "Orientation override reset." : `Orientation set to ${orientationOverride} deg clockwise.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to update orientation", "error");
    }
  }

  async function onFindSimilar() {
    if (!activeWorkspaceId) {
      updateStatus("Open a workspace before finding similar photos.", "warn");
      return;
    }
    const targetCount = folderPhotos.length;
    const folderLabel = activeFolderPath || "All Photos";
    updateStatus(`Finding similar photos in ${folderLabel}...`, "busy");
    setIsFindingSimilar(true);
    setSimilarityProgress({
      percent: 8,
      label: "Preparing similarity scan",
      detail: `${targetCount} photo${targetCount === 1 ? "" : "s"} in scope`
    });
    const stages = [
      { percent: 24, label: "Loading candidates", detail: "Reading file metadata and display images" },
      { percent: 48, label: "Computing pHash", detail: "Comparing perceptual hashes for near matches" },
      { percent: 72, label: "Checking visual similarity", detail: "Running CLIP when available" },
      { percent: 90, label: "Building groups", detail: "Choosing keep candidates and delete suggestions" }
    ];
    let stageIndex = 0;
    const progressTimer = window.setInterval(() => {
      const nextStage = stages[Math.min(stageIndex, stages.length - 1)];
      setSimilarityProgress(nextStage);
      if (stageIndex < stages.length - 1) {
        stageIndex += 1;
      }
    }, 900);
    try {
      const payload = await findSimilarPhotos({ workspaceId: activeWorkspaceId, includeClip: true, scope: "current", folderPath: activeFolderPath });
      const groups = applySimilarPayload(payload);
      const cacheDetail = payload.cache?.hit ? `Loaded from ${payload.cache.source} cache` : "Computed fresh similarity groups";
      setSimilarityProgress({
        percent: 100,
        label: groups.length ? `Found ${groups.length} group${groups.length === 1 ? "" : "s"}` : "No similar groups",
        detail: `${cacheDetail}; CLIP ${payload.stages.clip.status}`
      });
      updateStatus(
        groups.length
          ? `${payload.cache?.hit ? "Loaded cached" : "Found"} ${groups.length} similar group(s).`
          : "No similar groups found.",
        groups.length ? "ok" : "warn"
      );
    } catch (err) {
      setSimilarityProgress({
        percent: 100,
        label: "Similarity scan failed",
        detail: err instanceof Error ? err.message : "Failed to find similar photos"
      });
      updateStatus(err instanceof Error ? err.message : "Failed to find similar photos", "error");
    } finally {
      window.clearInterval(progressTimer);
      setIsFindingSimilar(false);
    }
  }

  useEffect(() => {
    if (activeTab !== "duplicates" || !activeWorkspaceId || isFindingSimilar) {
      return;
    }

    const workspaceId = activeWorkspaceId;
    let cancelled = false;
    async function loadCachedSimilarity() {
      try {
        const payload = await findSimilarPhotos({
          workspaceId,
          includeClip: true,
          scope: "current",
          folderPath: activeFolderPath,
          cacheOnly: true
        });
        if (cancelled) {
          return;
        }
        if (!payload.cache?.hit) {
          setSimilarGroups([]);
          setSimilarDeleteIds(new Set());
          setSimilarityProgress(null);
          return;
        }
        const groups = applySimilarPayload(payload);
        setSimilarityProgress({
          percent: 100,
          label: groups.length ? `Loaded ${groups.length} cached group${groups.length === 1 ? "" : "s"}` : "No cached groups",
          detail: `Restored from ${payload.cache.source} cache; CLIP ${payload.stages.clip.status}`
        });
        updateStatus(
          groups.length ? `Loaded ${groups.length} cached similar group(s).` : "No cached similar groups.",
          groups.length ? "ok" : "warn"
        );
      } catch {
        if (!cancelled) {
          setSimilarityProgress(null);
        }
      }
    }

    void loadCachedSimilarity();
    return () => {
      cancelled = true;
    };
  }, [activeTab, activeWorkspaceId, activeFolderPath, applySimilarPayload, isFindingSimilar, updateStatus]);

  const selectSimilarityVerticalNeighbor = useCallback((direction: "up" | "down") => {
    if (!activePhoto) {
      return false;
    }
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".duplicates-workspace .similar-thumb[data-photo-id]"));
    const current = cards.find((card) => card.dataset.photoId === activePhoto.id);
    if (!current) {
      return false;
    }
    const currentRect = current.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    const candidates = cards
      .map((card) => {
        const rect = card.getBoundingClientRect();
        return {
          card,
          id: card.dataset.photoId,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      })
      .filter((item) => item.id && (direction === "up" ? item.y < currentY - 4 : item.y > currentY + 4))
      .sort((a, b) => {
        const rowDistance = direction === "up" ? b.y - a.y : a.y - b.y;
        if (Math.abs(rowDistance) > 4) {
          return rowDistance;
        }
        return Math.abs(a.x - currentX) - Math.abs(b.x - currentX);
      });
    const next = candidates[0];
    if (!next?.id) {
      return false;
    }
    setActiveId(next.id);
    next.card.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }, [activePhoto, setActiveId]);

  const getGridColumnCount = useCallback((selector: string) => {
    const gallery = document.querySelector(selector);
    const cards = gallery ? Array.from(gallery.querySelectorAll<HTMLElement>("[data-photo-id]")) : [];
    if (!cards.length) {
      return 1;
    }
    const firstTop = cards[0].getBoundingClientRect().top;
    return Math.max(1, cards.filter((card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 2).length);
  }, []);

  const scrollSelectedPhotoIntoView = useCallback((id: string, rootSelector?: string) => {
    window.requestAnimationFrame(() => {
      const root = rootSelector ? document.querySelector(rootSelector) : document;
      root?.querySelector<HTMLElement>(`[data-photo-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }, []);

  const selectPhotoByOffset = useCallback((ids: string[], offset: number, rootSelector?: string) => {
    if (!activePhoto || !ids.length) {
      return false;
    }
    const currentIndex = ids.findIndex((id) => id === activePhoto.id);
    if (currentIndex < 0) {
      return false;
    }
    const nextIndex = Math.min(Math.max(currentIndex + offset, 0), ids.length - 1);
    if (nextIndex === currentIndex) {
      return false;
    }
    const nextId = ids[nextIndex];
    setActiveId(nextId);
    scrollSelectedPhotoIntoView(nextId, rootSelector);
    return true;
  }, [activePhoto, scrollSelectedPhotoIntoView, setActiveId]);

  const selectGlobalPhotoDirection = useCallback((direction: "left" | "right" | "up" | "down") => {
    if (isInspectorPreviewOpen) {
      return false;
    }
    const focusedElement = document.activeElement;
    const isLibraryFocused = focusedElement instanceof HTMLElement && Boolean(focusedElement.closest(".folder-browser-panel"));
    if (isLibraryFocused) {
      const ids = folderPhotos.map((photo) => photo.id);
      const columns = getGridColumnCount(".folder-browser-panel .folder-item-grid");
      const offset = direction === "left" ? -1 : direction === "right" ? 1 : direction === "up" ? -columns : columns;
      return selectPhotoByOffset(ids, offset, ".folder-browser-panel");
    }
    if (activeTab === "duplicates") {
      if (direction === "left") {
        if (!similarNavigation?.previousId) return false;
        setActiveId(similarNavigation.previousId);
        scrollSelectedPhotoIntoView(similarNavigation.previousId, ".duplicates-workspace");
        return true;
      }
      if (direction === "right") {
        if (!similarNavigation?.nextId) return false;
        setActiveId(similarNavigation.nextId);
        scrollSelectedPhotoIntoView(similarNavigation.nextId, ".duplicates-workspace");
        return true;
      }
      return selectSimilarityVerticalNeighbor(direction === "up" ? "up" : "down");
    }

    if (activeTab === "review") {
      const ids = folderPhotos.map((photo) => photo.id);
      const columns = getGridColumnCount(".review-workspace .bridge-gallery");
      const offset = direction === "left" ? -1 : direction === "right" ? 1 : direction === "up" ? -columns : columns;
      return selectPhotoByOffset(ids, offset, ".review-workspace .bridge-gallery");
    }

    if (activeTab === "export") {
      const offset = direction === "left" || direction === "up" ? -1 : 1;
      return selectPhotoByOffset(exportQueueList, offset, ".export-list");
    }

    const librarySelectedOnly = activeTab === "stats";
    if (librarySelectedOnly) {
      const ids = folderPhotos.map((photo) => photo.id);
      const columns = getGridColumnCount(".folder-browser-panel .folder-item-grid");
      const offset = direction === "left" ? -1 : direction === "right" ? 1 : direction === "up" ? -columns : columns;
      return selectPhotoByOffset(ids, offset, ".folder-browser-panel");
    }

    const ids = visiblePhotos.map((photo) => photo.id);
    const columns = getGridColumnCount(".browse-workspace .bridge-gallery");
    const offset = direction === "left" ? -1 : direction === "right" ? 1 : direction === "up" ? -columns : columns;
    return selectPhotoByOffset(ids, offset, ".browse-workspace .bridge-gallery");
  }, [
    activeTab,
    exportQueueList,
    folderPhotos,
    getGridColumnCount,
    isInspectorPreviewOpen,
    scrollSelectedPhotoIntoView,
    selectPhotoByOffset,
    selectSimilarityVerticalNeighbor,
    setActiveId,
    similarNavigation,
    visiblePhotos
  ]);

  const appShortcutScopes = useMemo<ShortcutScope[]>(() => {
    const scopes: ShortcutScope[] = ["global"];
    if (activeTab === "duplicates" && !isInspectorPreviewOpen) {
      scopes.unshift("similarity");
    }
    return scopes;
  }, [activeTab, isInspectorPreviewOpen]);

  const shortcutHelpScopes = useMemo<ShortcutScope[]>(() => {
    const scopes: ShortcutScope[] = ["global"];
    if (activeTab === "duplicates") {
      scopes.push("similarity");
    }
    if (activeTab === "review") {
      scopes.push("review");
    }
    return scopes;
  }, [activeTab]);

  const appShortcutHandlers = useMemo<ShortcutHandlers>(() => ({
    "global.openPreview": () => {
      if (!activePhoto || isInspectorPreviewOpen) {
        return false;
      }
      setOpenPreviewSignal((value) => value + 1);
    },
    "global.toggleQueue": () => {
      if (!activePhoto || activeTab === "review") {
        return false;
      }
      toggleExportQueue(activePhoto.id);
      updateStatus(exportQueueIds.has(activePhoto.id) ? "Removed photo from export queue." : "Added photo to export queue.", "ok");
    },
    "global.showHelp": () => {
      setIsShortcutHelpOpen(true);
    },
    "global.previousPhoto": () => selectGlobalPhotoDirection("left"),
    "global.nextPhoto": () => selectGlobalPhotoDirection("right"),
    "global.photoDown": () => selectGlobalPhotoDirection("down"),
    "global.photoUp": () => selectGlobalPhotoDirection("up"),
    "similarity.previous": () => {
      if (!similarNavigation?.previousId) {
        return false;
      }
      setActiveId(similarNavigation.previousId);
    },
    "similarity.next": () => {
      if (!similarNavigation?.nextId) {
        return false;
      }
      setActiveId(similarNavigation.nextId);
    },
    "similarity.up": () => selectSimilarityVerticalNeighbor("up"),
    "similarity.down": () => selectSimilarityVerticalNeighbor("down")
  }), [activePhoto, activeTab, exportQueueIds, isInspectorPreviewOpen, selectGlobalPhotoDirection, selectSimilarityVerticalNeighbor, setActiveId, similarNavigation, toggleExportQueue, updateStatus]);

  useShortcuts({
    shortcuts: shortcutRegistry,
    handlers: appShortcutHandlers,
    activeScopes: appShortcutScopes,
    disabled: isShortcutHelpOpen
  });

  function onToggleSimilarDelete(id: string) {
    setSimilarDeleteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function onDeleteSimilarSelected() {
    if (!similarDeleteIds.size) {
      updateStatus("Choose photos to delete first.", "warn");
      return;
    }

    const count = similarDeleteIds.size;
    const confirmed = window.confirm(`Remove ${count} photo(s) from this workspace? Original files will stay on disk.`);
    if (!confirmed) {
      return;
    }

    updateStatus(`Removing ${count} photo(s) from this workspace...`, "busy");
    setIsDeletingSimilar(true);
    try {
      const result = await deletePhotos([...similarDeleteIds]);
      setSimilarDeleteIds(new Set());
      setSimilarGroups([]);
      await loadLibrary(activeWorkspaceId);
      updateStatus(`Removed ${result.deletedRecords} photo(s) from this workspace.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to delete photos", "error");
    } finally {
      setIsDeletingSimilar(false);
    }
  }

  const commonBrowseProps = {
    ratings,
    activePhotoId: activePhoto?.id ?? null,
    viewMode,
    sortMode,
    search,
    minScore,
    ratingFilter,
    exportQueueIds,
    onSearchChange: setSearch,
    onMinScoreChange: setMinScore,
    onRatingFilterChange: setRatingFilter,
    onSortModeChange: setSortMode,
    onViewModeChange: setViewMode,
    onSelectPhoto: setActiveId,
    onRatePhoto: ratePhoto,
    onAutoRateByScore,
    onToggleExportQueue: toggleExportQueue
  };

  let workspace = (
    <BrowseWorkspace
      {...commonBrowseProps}
      photos={visiblePhotos}
      folderPhotosCount={folderPhotos.length}
      keepRate={keepRate}
      onAddVisibleToQueue={addVisibleToQueue}
    />
  );

  if (activeTab === "review") {
    workspace = (
      <ReviewWorkspace
        activePhoto={activePhoto}
        folderPhotos={folderPhotos}
        ratings={ratings}
        exportQueueIds={exportQueueIds}
        shortcutsDisabled={isShortcutHelpOpen}
        onSelectPhoto={setActiveId}
        onRatePhoto={ratePhoto}
        onAutoRateByScore={onAutoRateByScore}
        onToggleExportQueue={toggleExportQueue}
      />
    );
  } else if (activeTab === "duplicates") {
    workspace = (
      <DuplicatesWorkspace
        similarGroups={similarGroups}
        similarDeleteIds={similarDeleteIds}
        exportQueueIds={exportQueueIds}
        activePhotoId={activePhoto?.id ?? null}
        isFindingSimilar={isFindingSimilar}
        isDeletingSimilar={isDeletingSimilar}
        similarityProgress={similarityProgress}
        activeFolderPath={activeFolderPath}
        onFindSimilar={onFindSimilar}
        onSelectPhoto={setActiveId}
        onToggleSimilarDelete={onToggleSimilarDelete}
        onDeleteSimilarSelected={onDeleteSimilarSelected}
        onAddToExportQueue={addToExportQueue}
      />
    );
  } else if (activeTab === "export") {
    workspace = (
      <ExportWorkspace
        photos={photos}
        queuedIds={exportQueueList}
        activePhotoId={activePhoto?.id ?? null}
        onRemove={removeFromExportQueue}
        onClear={() => {
          if (!activeWorkspaceId) return;
          setExportQueues((prev) => ({ ...prev, [activeWorkspaceId]: [] }));
        }}
        onExport={onExport}
        onSelectPhoto={setActiveId}
      />
    );
  } else if (activeTab === "stats") {
    workspace = (
      <StatsWorkspace
        activeFolder={activeFolder}
        totalPhotos={photos.length}
        visibleCount={visiblePhotos.length}
        folderPhotosCount={folderPhotos.length}
        ratedCount={ratedCount}
        exportQueueCount={exportQueueList.length}
        fourPlusCount={fourPlusIds.length}
        processingInFlight={processingInFlight}
        completedCount={completedCount}
        processingTotal={processingTotal}
        keepRate={keepRate}
        reviewRate={reviewRate}
        processingProgress={processingProgress}
      />
    );
  }

  const workspaceControls = (
    <section className="workspace-control-panel">
      <div className="side-panel-head">
        <div>
          <span className="panel-kicker">Workspace</span>
          <strong>{activeWorkspace?.name ?? "No Workspace"}</strong>
        </div>
        <span>{library.workspaces.length}</span>
      </div>
      <select
        className="workspace-control-select"
        value={activeWorkspaceId ?? ""}
        onChange={(event) => {
          const selectedValue = event.target.value;
          if (!selectedValue) return;
          if (selectedValue === NEW_WORKSPACE_FROM_FOLDER_VALUE) {
            void onOpenFolder();
            return;
          }
          void activateWorkspace(selectedValue);
        }}
        aria-label="Photo workspace"
      >
        {library.workspaces.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
        <option value={NEW_WORKSPACE_FROM_FOLDER_VALUE}>New Workspace from Folder...</option>
      </select>
      <div className="workspace-control-path" title={activeWorkspace?.rootPath ?? ""}>{activeWorkspace?.rootPath ?? ""}</div>
      <div className="workspace-control-actions">
        <button className="link-button" onClick={() => void onRevealWorkspaceFolder()}>Open Folder</button>
        <button className="link-button" disabled={!excludedCount} onClick={() => void restoreRemoved()}>
          Restore Removed ({excludedCount})
        </button>
      </div>
    </section>
  );

  if (!activeWorkspace) {
    return (
      <>
        <WorkspaceLauncher
          workspaces={library.workspaces}
          statusText={statusText}
          statusTone={statusTone}
          isLoading={!library.isLibraryReady || library.isLibraryLoading}
          onOpenFolder={() => void onOpenFolder()}
          onOpenWorkspaceFile={() => void onOpenWorkspaceFile()}
          onWorkspaceChange={(workspaceId) => {
            void activateWorkspace(workspaceId);
          }}
        />
        <ShortcutHelpDialog
          open={isShortcutHelpOpen}
          scopes={shortcutHelpScopes}
          onClose={() => setIsShortcutHelpOpen(false)}
        />
      </>
    );
  }

  return (
    <>
      <WorkspaceShell
        activeTab={activeTab}
        currentPath={activeWorkspace ? `${activeWorkspace.name} / ${activeFolder ? formatFolderLabel(activeFolder) : "All Photos"}` : "No Workspace"}
        exportQueueCount={exportQueueList.length}
        isRefreshing={isRefreshing}
        isRescoring={isRescoring}
        backgroundProgress={backgroundProgress}
        onTabChange={setActiveTab}
        onRefresh={() => void onRefresh()}
        onRefreshScores={() => void onRefreshScores()}
        onExportQueue={() => void onExport()}
        sidebar={
          <>
            {workspaceControls}
            <FolderNavigator
              folders={folders}
              photos={folderPhotos}
              activeFolderPath={activeFolderPath}
              activePhotoId={activePhoto?.id ?? null}
              onSelectFolder={setActiveFolderPath}
              onSelectPhoto={setActiveId}
            />
          </>
        }
        inspector={
          <InspectorPanel
            activePhoto={activePhoto}
            ratings={ratings}
            exportQueueIds={exportQueueIds}
            openPreviewSignal={openPreviewSignal}
            shortcutsDisabled={isShortcutHelpOpen}
            similarNavigation={similarNavigation}
            onRatePhoto={ratePhoto}
            onToggleExportQueue={toggleExportQueue}
            onSelectPhoto={setActiveId}
            onPreviewOpenChange={setIsInspectorPreviewOpen}
            onToggleSimilarRemove={onToggleSimilarDelete}
            onSaveScoreOverride={saveScoreOverride}
            onSaveOrientationOverride={saveOrientationOverride}
          />
        }
      >
        {workspace}
      </WorkspaceShell>
      <ShortcutHelpDialog
        open={isShortcutHelpOpen}
        scopes={shortcutHelpScopes}
        onClose={() => setIsShortcutHelpOpen(false)}
      />
    </>
  );
}

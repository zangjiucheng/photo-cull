import { useCallback, useMemo, useState } from "react";
import { deletePhotos, exportPhotos, findSimilarPhotos, updatePhotoRating, updatePhotoScore } from "./api";
import { FolderNavigator } from "./components/library/FolderNavigator";
import { InspectorPanel } from "./components/library/InspectorPanel";
import { BrowseWorkspace } from "./components/workspaces/BrowseWorkspace";
import { DuplicatesWorkspace } from "./components/workspaces/DuplicatesWorkspace";
import { ExportWorkspace } from "./components/workspaces/ExportWorkspace";
import { ReviewWorkspace } from "./components/workspaces/ReviewWorkspace";
import { StatsWorkspace } from "./components/workspaces/StatsWorkspace";
import { WorkspaceShell } from "./components/workspaces/WorkspaceShell";
import { useLibrary } from "./hooks/useLibrary";
import { usePhotoFilters } from "./hooks/usePhotoFilters";
import { usePhotoRatings } from "./hooks/usePhotoRatings";
import type { LibraryFolder, Photo, RatingFilter, SimilarGroup, SortMode, StatusTone, ViewMode, WorkspaceTab } from "./types";

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
  const [exportQueues, setExportQueues] = useState<Record<string, string[]>>({});
  const [similarGroups, setSimilarGroups] = useState<SimilarGroup[]>([]);
  const [similarDeleteIds, setSimilarDeleteIds] = useState<Set<string>>(new Set());
  const [isFindingSimilar, setIsFindingSimilar] = useState(false);
  const [isDeletingSimilar, setIsDeletingSimilar] = useState(false);
  const [similarSummary, setSimilarSummary] = useState("");

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
    activeWorkspace,
    activeWorkspaceId,
    setActiveWorkspaceId,
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
  const reviewRate = photos.length ? Math.round((ratedCount / photos.length) * 100) : 0;
  const completedCount = photos.filter((p) => p.status === "done" || p.status === "error").length;
  const processingTotal = photos.length;
  const processingInFlight = library.pendingCount + library.processingCount;
  const processingProgress = processingTotal
    ? Math.max(0, Math.min(100, Math.round((completedCount / processingTotal) * 100)))
    : 0;

  function toggleExportQueue(id: string) {
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
  }

  function addToExportQueue(id: string) {
    if (!activeWorkspaceId) return;
    setExportQueues((prev) => ({ ...prev, [activeWorkspaceId]: Array.from(new Set([...(prev[activeWorkspaceId] ?? []), id])) }));
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
      await refresh();
      updateStatus("Refresh complete.", "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Refresh failed", "error");
    } finally {
      setIsRefreshing(false);
    }
  }

  async function onFindSimilar() {
    if (!activeWorkspaceId) {
      updateStatus("Open a workspace before finding similar photos.", "warn");
      return;
    }
    updateStatus("Finding similar photos...", "busy");
    setIsFindingSimilar(true);
    try {
      const payload = await findSimilarPhotos({ workspaceId: activeWorkspaceId, includeClip: true, scope: "current", folderPath: activeFolderPath });
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
      setSimilarSummary(
        `pHash <= ${payload.stages.phash.exactDistance} duplicate, ${payload.stages.phash.reviewDistance} review; CLIP ${payload.stages.clip.status}`
      );
      updateStatus(groups.length ? `Found ${groups.length} similar group(s).` : "No similar groups found.", groups.length ? "ok" : "warn");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to find similar photos", "error");
    } finally {
      setIsFindingSimilar(false);
    }
  }

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
      setSimilarSummary("");
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
        isFindingSimilar={isFindingSimilar}
        isDeletingSimilar={isDeletingSimilar}
        similarSummary={similarSummary}
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

  return (
    <WorkspaceShell
      activeTab={activeTab}
      statusText={statusText}
      statusTone={statusTone}
      currentPath={activeWorkspace ? `${activeWorkspace.name} / ${activeFolder ? formatFolderLabel(activeFolder) : "All Photos"}` : "No Workspace"}
      workspaces={library.workspaces}
      activeWorkspaceId={activeWorkspaceId}
      excludedCount={excludedCount}
      exportQueueCount={exportQueueList.length}
      isRefreshing={isRefreshing}
      onTabChange={setActiveTab}
      onOpenFolder={() => void onOpenFolder()}
      onWorkspaceChange={(workspaceId) => {
        setActiveWorkspaceId(workspaceId);
        void loadLibrary(workspaceId);
      }}
      onRefresh={() => void onRefresh()}
      onExportQueue={() => void onExport()}
      onRestoreRemoved={() => void restoreRemoved()}
      sidebar={
        <FolderNavigator
          folders={folders}
          activeFolderPath={activeFolderPath}
          visibleCount={visiblePhotos.length}
          onSelectFolder={setActiveFolderPath}
        />
      }
      inspector={
        <InspectorPanel
          activePhoto={activePhoto}
          ratings={ratings}
          onRatePhoto={ratePhoto}
          onSaveScoreOverride={saveScoreOverride}
        />
      }
    >
      {workspace}
    </WorkspaceShell>
  );
}

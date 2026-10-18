import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelExportEnhanceJob, createExportEnhanceJob, deletePhotos, matchExposure, relocateWorkspace, fetchExportEnhanceJob, findSimilarPhotos, listExportEnhanceJobs, resumeExportEnhanceJob, saveExportEnhanceSettings, saveExportQueue, updatePhotoOrientation, updatePhotoRating, updatePhotoScore } from "./api";
import { FolderNavigator } from "./components/library/FolderNavigator";
import { InspectorPanel } from "./components/library/InspectorPanel";
import { BrowseWorkspace } from "./components/workspaces/BrowseWorkspace";
import { SettingsWorkspace } from "./components/workspaces/SettingsWorkspace";
import { Onboarding, onboardingPending } from "./components/Onboarding";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DuplicatesWorkspace } from "./components/workspaces/DuplicatesWorkspace";
import { ExportEnhanceWorkspace } from "./components/workspaces/ExportEnhanceWorkspace";
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
import type { AiRuntimeStatus, ExportEnhanceJob, ExportEnhanceSettings, LibraryFolder, Photo, RatingFilter, SimilarGroup, SimilarPayload, SortMode, StatusTone, ViewMode, WorkspaceTab } from "./types";

import { cloneSettings, defaultSettings, pasteSettings, rebasePad, type AdjustmentGroup } from "./editing/recipe";

const NEW_WORKSPACE_FROM_FOLDER_VALUE = "__new_workspace_from_folder__";
const WORKSPACE_LABELS: Record<WorkspaceTab, string> = {
  browse: "Browse",
  review: "Review",
  duplicates: "Similarity",
  "export-enhance": "Enhance & Export",
  stats: "Stats",
  settings: "Settings",
};
const WORKSPACE_TABS: WorkspaceTab[] = ["browse", "review", "duplicates", "export-enhance", "stats", "settings"];

interface SimilarityProgress {
  percent: number;
  label: string;
  detail: string;
}

const defaultExportEnhanceSettings = defaultSettings;
const cloneExportEnhanceSettings = cloneSettings;

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
  const [aiRuntimeStatus, setAiRuntimeStatus] = useState<AiRuntimeStatus | null>(null);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [exportEnhanceSettings, setExportEnhanceSettings] = useState<ExportEnhanceSettings>(defaultExportEnhanceSettings);
  const [exportEnhanceSettingsByPhoto, setExportEnhanceSettingsByPhoto] = useState<Record<string, ExportEnhanceSettings>>({});
  const [exportEnhanceUndoStacks, setExportEnhanceUndoStacks] = useState<Record<string, ExportEnhanceSettings[]>>({});
  const exportEnhanceWorkspaceRef = useRef<string | null>(null);
  const skipNextEnhancePersistRef = useRef(false);
  const pendingEnhanceSaveRef = useRef<{ id: string; settings: Record<string, ExportEnhanceSettings> } | null>(null);
  const enhanceSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const [enhanceSaveState, setEnhanceSaveState] = useState<"saved" | "saving" | "failed">("saved");
  const [enhanceSaveError, setEnhanceSaveError] = useState("");
  const enhanceByPhotoRef = useRef(exportEnhanceSettingsByPhoto);
  enhanceByPhotoRef.current = exportEnhanceSettingsByPhoto;
  const [exportEnhanceSelectedPhotoId, setExportEnhanceSelectedPhotoId] = useState<string | null>(null);
  const [exportEnhanceOutputFolder, setExportEnhanceOutputFolderState] = useState("");
  const [exportEnhanceJob, setExportEnhanceJob] = useState<ExportEnhanceJob | null>(null);
  const [isStartingExportEnhance, setIsStartingExportEnhance] = useState(false);
  const [exportEnhanceRedoStacks, setExportEnhanceRedoStacks] = useState<Record<string, ExportEnhanceSettings[]>>({});
  const enhanceGestureRef = useRef<{ id: string; before: ExportEnhanceSettings } | null>(null);
  const enhanceSettingsRef = useRef(exportEnhanceSettings);
  enhanceSettingsRef.current = exportEnhanceSettings;
  const [isEnhancePreviewOpen, setIsEnhancePreviewOpen] = useState(false);

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
    removeWorkspace,
    restoreRemoved,
    excludedCount,
    serverExportQueue,
    serverExportEnhanceSettings
  } = library;
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;
  // Remember the export folder per workspace on this device so it survives a restart.
  const outputFolderKey = (workspaceId: string) => `photo-cull.export-folder.${workspaceId}`;
  const setExportEnhanceOutputFolder = useCallback((folder: string) => {
    setExportEnhanceOutputFolderState(folder);
    if (!activeWorkspaceIdRef.current) return;
    try {
      localStorage.setItem(outputFolderKey(activeWorkspaceIdRef.current), folder);
    } catch {
      // Remembering the folder is a convenience; the export still works without it.
    }
  }, []);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    try {
      setExportEnhanceOutputFolderState(localStorage.getItem(outputFolderKey(activeWorkspaceId)) ?? "");
    } catch {
      setExportEnhanceOutputFolderState("");
    }
  }, [activeWorkspaceId]);
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

  useEffect(() => {
    if (!window.aiCulling?.getAiRuntimeStatus) {
      return;
    }
    let cancelled = false;
    window.aiCulling.getAiRuntimeStatus()
      .then((status) => {
        if (!cancelled) setAiRuntimeStatus(status);
      })
      .catch(() => undefined);
    const unsubscribe = window.aiCulling.onAiRuntimeStatus?.((status) => {
      setAiRuntimeStatus(status);
      if (status.state === "installed" && status.using) {
        updateStatus("AI runtime is active.", "ok");
        void loadLibrary(activeWorkspaceId);
      }
      if (status.state === "error") {
        updateStatus(status.error || "AI runtime installation failed.", "error");
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [activeWorkspaceId, loadLibrary, updateStatus]);

  const keepRate = folderPhotos.length ? Math.round((visiblePhotos.length / folderPhotos.length) * 100) : 0;
  const ratedCount = ratings.size;
  const fourPlusIds = photos.filter((photo) => (ratings.get(photo.id) ?? photo.rating ?? 0) >= 4).map((photo) => photo.id);
  const exportQueueIds = useMemo(() => new Set(activeWorkspaceId ? exportQueues[activeWorkspaceId] ?? [] : []), [activeWorkspaceId, exportQueues]);
  const exportQueueList = useMemo(() => Array.from(exportQueueIds), [exportQueueIds]);
  const exportEnhanceCurrentPhotoId = exportEnhanceSelectedPhotoId ?? exportQueueList[0] ?? null;
  const canUndoExportEnhance = Boolean(exportEnhanceCurrentPhotoId && (exportEnhanceUndoStacks[exportEnhanceCurrentPhotoId]?.length ?? 0) > 0);
  useEffect(() => {
    if (!activeWorkspaceId || library.loadedWorkspaceId !== activeWorkspaceId) return;
    setExportQueues((prev) => ({ ...prev, [activeWorkspaceId]: serverExportQueue }));
  }, [activeWorkspaceId, serverExportQueue, library.loadedWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      exportEnhanceWorkspaceRef.current = null;
      setExportEnhanceSettingsByPhoto({});
      setExportEnhanceSettings(defaultExportEnhanceSettings);
      return;
    }
    if (exportEnhanceWorkspaceRef.current === activeWorkspaceId) {
      return;
    }
    if (library.loadedWorkspaceId !== activeWorkspaceId) return;
    exportEnhanceWorkspaceRef.current = activeWorkspaceId;
    skipNextEnhancePersistRef.current = true;
    let recovered = serverExportEnhanceSettings;
    try {
      const draft = JSON.parse(localStorage.getItem(`photo-cull.pending-edits.${activeWorkspaceId}`) ?? "null");
      if (draft && typeof draft === "object" && !Array.isArray(draft)) recovered = { ...recovered, ...draft };
    } catch { /* A damaged local draft must not block opening the library. */ }
    setExportEnhanceSettingsByPhoto(recovered);
    const targetId = exportEnhanceSelectedPhotoId && serverExportQueue.includes(exportEnhanceSelectedPhotoId) ? exportEnhanceSelectedPhotoId : serverExportQueue[0] ?? null;
    setExportEnhanceSelectedPhotoId(targetId);
    setExportEnhanceUndoStacks({});
    setExportEnhanceRedoStacks({});
    setExportEnhanceSettings(cloneExportEnhanceSettings(targetId ? recovered[targetId] ?? defaultExportEnhanceSettings : defaultExportEnhanceSettings));
  }, [activeWorkspaceId, exportEnhanceSelectedPhotoId, serverExportEnhanceSettings, serverExportQueue, library.loadedWorkspaceId]);

  const flushEnhanceSave = useCallback(() => {
    const pending = pendingEnhanceSaveRef.current;
    if (!pending) return;
    pendingEnhanceSaveRef.current = null;
    const snapshot = JSON.stringify(pending.settings);
    enhanceSaveChainRef.current = enhanceSaveChainRef.current.catch(() => undefined).then(async () => {
      try {
        await saveExportEnhanceSettings(pending.id, pending.settings);
      } catch (error) {
        if (exportEnhanceWorkspaceRef.current === pending.id) {
          setEnhanceSaveState("failed");
          setEnhanceSaveError(error instanceof Error ? error.message : "Unable to save edits");
        }
        return;
      }
      try {
        const key = `photo-cull.pending-edits.${pending.id}`;
        if (localStorage.getItem(key) === snapshot) localStorage.removeItem(key);
      } catch { /* Database save succeeded; clearing a recovery draft is best effort. */ }
      if (exportEnhanceWorkspaceRef.current === pending.id && JSON.stringify(enhanceByPhotoRef.current) === snapshot) {
        setEnhanceSaveState("saved");
        setEnhanceSaveError("");
      }
    });
  }, [updateStatus]);

  useEffect(() => {
    if (!activeWorkspaceId || exportEnhanceWorkspaceRef.current !== activeWorkspaceId || library.loadedWorkspaceId !== activeWorkspaceId) return;
    if (skipNextEnhancePersistRef.current) {
      skipNextEnhancePersistRef.current = false;
      return;
    }
    pendingEnhanceSaveRef.current = { id: activeWorkspaceId, settings: exportEnhanceSettingsByPhoto };
    setEnhanceSaveState("saving");
    try { localStorage.setItem(`photo-cull.pending-edits.${activeWorkspaceId}`, JSON.stringify(exportEnhanceSettingsByPhoto)); }
    catch { updateStatus("Local draft storage is full; keep the app open until edits save.", "warn"); }
    const timer = window.setTimeout(flushEnhanceSave, 700);
    return () => window.clearTimeout(timer);
  }, [activeWorkspaceId, exportEnhanceSettingsByPhoto, updateStatus, flushEnhanceSave, library.loadedWorkspaceId]);

  useEffect(() => {
    const flush = () => flushEnhanceSave();
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [activeWorkspaceId, flushEnhanceSave]);

  const commitExportQueue = useCallback((ids: string[], statusMessage?: string) => {
    if (!activeWorkspaceId) return;
    const nextIds = Array.from(new Set(ids));
    setExportQueues((prev) => ({ ...prev, [activeWorkspaceId]: nextIds }));
    void saveExportQueue(activeWorkspaceId, nextIds)
      .then((payload) => {
        setExportQueues((prev) => ({ ...prev, [activeWorkspaceId]: payload.ids }));
        if (statusMessage) updateStatus(statusMessage, "ok");
      })
      .catch((err) => {
        updateStatus(err instanceof Error ? err.message : "Failed to save export queue", "error");
      });
  }, [activeWorkspaceId, updateStatus]);
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
    const next = new Set(exportQueues[activeWorkspaceId] ?? []);
    const removing = next.has(id);
    if (removing) {
      next.delete(id);
    } else {
      next.add(id);
    }
    commitExportQueue(Array.from(next), removing ? "Removed photo from export queue." : "Added photo to export queue.");
  }, [activeWorkspaceId, commitExportQueue, exportQueues]);

  function addToExportQueue(id: string) {
    if (!activeWorkspaceId) return;
    commitExportQueue([...(exportQueues[activeWorkspaceId] ?? []), id], "Added photo to export queue.");
  }

  function addVisibleToQueue() {
    if (!visiblePhotos.length) {
      updateStatus("No visible photos to add.", "warn");
      return;
    }
    if (!activeWorkspaceId) return;
    commitExportQueue([...(exportQueues[activeWorkspaceId] ?? []), ...visiblePhotos.map((photo) => photo.id)], `Added ${visiblePhotos.length} visible photo(s) to export queue.`);
  }

  function removeVisibleFromQueue() {
    if (!activeWorkspaceId) return;
    const visibleIds = new Set(visiblePhotos.map((photo) => photo.id));
    if (!visibleIds.size) {
      updateStatus("No visible photos to remove from queue.", "warn");
      return;
    }
    const currentIds = exportQueues[activeWorkspaceId] ?? [];
    const nextIds = currentIds.filter((id) => !visibleIds.has(id));
    const removedCount = currentIds.length - nextIds.length;
    if (!removedCount) {
      updateStatus("No visible photos are in the export queue.", "warn");
      return;
    }
    commitExportQueue(nextIds, `Removed ${removedCount} visible photo(s) from export queue.`);
  }

  function clearExportQueue() {
    if (!activeWorkspaceId) return;
    const currentIds = exportQueues[activeWorkspaceId] ?? [];
    if (!currentIds.length) {
      updateStatus("Export queue is already empty.", "warn");
      return;
    }
    if (currentIds.length > 1 && !window.confirm(`Remove all ${currentIds.length} photos from the export queue? Their edits are kept.`)) {
      return;
    }
    commitExportQueue([], `Removed ${currentIds.length} photo(s) from export queue.`);
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

  async function onRelocateWorkspace(workspaceId: string) {
    try {
      const selectedPath = window.aiCulling?.openFolder
        ? await window.aiCulling.openFolder()
        : window.prompt("Enter the folder's new path on this machine");
      if (!selectedPath) return;
      const workspace = await relocateWorkspace(workspaceId, selectedPath);
      await library.loadLibrary();
      updateStatus(`Reconnected ${workspace.name}.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to reconnect the folder", "error");
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

  async function onDeleteWorkspace(workspaceId: string) {
    const workspace = library.workspaces.find((item) => item.id === workspaceId);
    const confirmed = window.confirm(`Delete ${workspace?.name ?? "this workspace"} from the recent workspace list? Photos on disk will stay untouched.`);
    if (!confirmed) {
      return;
    }
    updateStatus("Deleting workspace...", "busy");
    try {
      await removeWorkspace(workspaceId);
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to delete workspace", "error");
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

  useEffect(() => window.aiCulling?.onOpenSettingsRequest?.(() => setActiveTab("settings")), []);
  useEffect(() => window.aiCulling?.onOpenOnboardingRequest?.(() => setIsOnboardingOpen(true)), []);
  useEffect(() => {
    void onboardingPending().then((pending) => {
      if (pending) setIsOnboardingOpen(true);
    });
  }, []);

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

  async function onChooseExportEnhanceFolder() {
    if (!window.aiCulling?.chooseOutputFolder) {
      const typed = window.prompt("Enter an output folder path");
      if (typed) setExportEnhanceOutputFolder(typed);
      return;
    }
    const folder = await window.aiCulling.chooseOutputFolder();
    if (folder) {
      setExportEnhanceOutputFolder(folder);
    }
  }

  const selectExportEnhancePhoto = useCallback((photoId: string) => {
    if (exportEnhanceSelectedPhotoId) {
      setExportEnhanceSettingsByPhoto((current) => ({
        ...current,
        [exportEnhanceSelectedPhotoId]: cloneExportEnhanceSettings(exportEnhanceSettings)
      }));
    }
    setExportEnhanceSelectedPhotoId(photoId);
    setExportEnhanceSettings(cloneExportEnhanceSettings(exportEnhanceSettingsByPhoto[photoId] ?? defaultExportEnhanceSettings));
  }, [exportEnhanceSelectedPhotoId, exportEnhanceSettings, exportEnhanceSettingsByPhoto]);

  function applyExportEnhanceSettings(nextSettings: ExportEnhanceSettings, pushUndo = true) {
    const targetId = exportEnhanceCurrentPhotoId;
    if (!targetId) return;
    const next = cloneExportEnhanceSettings(nextSettings);
    enhanceSettingsRef.current = next;
    if (pushUndo) {
      setExportEnhanceRedoStacks((current) => ({ ...current, [targetId]: [] }));
      setExportEnhanceUndoStacks((current) => ({
        ...current,
        [targetId]: [...(current[targetId] ?? []), cloneExportEnhanceSettings(exportEnhanceSettings)].slice(-50)
      }));
    }
    setExportEnhanceSettings(next);
    setExportEnhanceSettingsByPhoto((current) => ({ ...current, [targetId]: next }));
  }

  function updateExportEnhanceSettings(nextSettings: ExportEnhanceSettings) {
    applyExportEnhanceSettings(nextSettings, !enhanceGestureRef.current);
  }

  function undoExportEnhanceSettings() {
    const targetId = exportEnhanceCurrentPhotoId;
    if (!targetId) return;
    const stack = exportEnhanceUndoStacks[targetId] ?? [];
    const previous = stack[stack.length - 1];
    if (!previous) {
      updateStatus("No enhance adjustment to undo.", "warn");
      return;
    }
    setExportEnhanceUndoStacks((current) => ({ ...current, [targetId]: stack.slice(0, -1) }));
    setExportEnhanceRedoStacks((current) => ({ ...current, [targetId]: [...(current[targetId] ?? []), cloneSettings(exportEnhanceSettings)] }));
    applyExportEnhanceSettings(previous, false);
    updateStatus("Undid last enhance adjustment.", "ok");
  }

  function beginEnhanceGesture() {
    if (!exportEnhanceCurrentPhotoId || enhanceGestureRef.current) return;
    enhanceGestureRef.current = { id: exportEnhanceCurrentPhotoId, before: cloneSettings(exportEnhanceSettings) };
  }

  function endEnhanceGesture() {
    const gesture = enhanceGestureRef.current;
    enhanceGestureRef.current = null;
    if (!gesture || JSON.stringify(gesture.before) === JSON.stringify(enhanceSettingsRef.current)) return;
    setExportEnhanceUndoStacks(current => ({ ...current, [gesture.id]: [...(current[gesture.id] ?? []), gesture.before].slice(-50) }));
    setExportEnhanceRedoStacks(current => ({ ...current, [gesture.id]: [] }));
  }

  function redoExportEnhanceSettings() {
    const id = exportEnhanceCurrentPhotoId;
    if (!id) return;
    const stack = exportEnhanceRedoStacks[id] ?? [];
    if (!stack.length) return;
    setExportEnhanceUndoStacks(current => ({ ...current, [id]: [...(current[id] ?? []), cloneSettings(exportEnhanceSettings)].slice(-50) }));
    setExportEnhanceRedoStacks(current => ({ ...current, [id]: stack.slice(0, -1) }));
    applyExportEnhanceSettings(stack[stack.length - 1], false);
  }

  function applyAdjustmentsToQueue(source: ExportEnhanceSettings, groups: AdjustmentGroup[]) {
    const next = { ...exportEnhanceSettingsByPhoto };
    const history = { ...exportEnhanceUndoStacks };
    const redo = { ...exportEnhanceRedoStacks };
    for (const id of exportQueueList) {
      if (id === exportEnhanceCurrentPhotoId) continue;
      const before = cloneSettings(next[id] ?? defaultSettings);
      history[id] = [...(history[id] ?? []), before].slice(-50);
      redo[id] = [];
      next[id] = pasteSettings(before, source, groups);
    }
    setExportEnhanceSettingsByPhoto(next);
    setExportEnhanceUndoStacks(history);
    setExportEnhanceRedoStacks(redo);
    updateStatus(`Applied adjustments to ${Math.max(0, exportQueueList.length - 1)} queued photos.`, "ok");
  }

  async function matchQueueExposure() {
    if (!exportEnhanceCurrentPhotoId) throw new Error("Select a reference photo first");
    const targets = Object.fromEntries(exportQueueList
      .filter((id) => id !== exportEnhanceCurrentPhotoId)
      .map((id) => [id, exportEnhanceSettingsByPhoto[id] ?? defaultExportEnhanceSettings]));
    return matchExposure(exportEnhanceCurrentPhotoId, exportEnhanceSettings, targets);
  }

  // Exposure-only change per photo, recorded in each photo's undo history like a slider edit.
  function applyExposureMatches(exposures: Record<string, number>) {
    const next = { ...exportEnhanceSettingsByPhoto };
    const history = { ...exportEnhanceUndoStacks };
    const redo = { ...exportEnhanceRedoStacks };
    for (const [id, exposure] of Object.entries(exposures)) {
      const before = cloneSettings(next[id] ?? defaultSettings);
      history[id] = [...(history[id] ?? []), before].slice(-50);
      redo[id] = [];
      next[id] = rebasePad({ ...before, exposure, auto: null });
    }
    setExportEnhanceSettingsByPhoto(next);
    setExportEnhanceUndoStacks(history);
    setExportEnhanceRedoStacks(redo);
    updateStatus(`Matched exposure on ${Object.keys(exposures).length} photo(s).`, "ok");
  }

  function resetExportEnhanceSettings() {
    const targetId = exportEnhanceCurrentPhotoId;
    if (!targetId) return;
    applyExportEnhanceSettings(pasteSettings(defaultExportEnhanceSettings, exportEnhanceSettings, ["output"]), true);
    updateStatus("Reset enhance adjustments.", "ok");
  }

  const selectExportEnhanceDirection = useCallback((direction: "left" | "right") => {
    if (!exportQueueList.length) return false;
    const currentId = exportEnhanceSelectedPhotoId ?? exportQueueList[0];
    const currentIndex = exportQueueList.indexOf(currentId);
    const nextIndex = direction === "left"
      ? Math.max((currentIndex < 0 ? 0 : currentIndex) - 1, 0)
      : Math.min((currentIndex < 0 ? 0 : currentIndex) + 1, exportQueueList.length - 1);
    const nextId = exportQueueList[nextIndex];
    if (!nextId || nextId === currentId) return false;
    selectExportEnhancePhoto(nextId);
    return true;
  }, [exportEnhanceSelectedPhotoId, exportQueueList, selectExportEnhancePhoto]);

  useEffect(() => {
    if (!exportQueueList.length) {
      setExportEnhanceSelectedPhotoId(null);
      setIsEnhancePreviewOpen(false);
      return;
    }
    if (!exportEnhanceSelectedPhotoId || !exportQueueList.includes(exportEnhanceSelectedPhotoId)) {
      const nextId = exportQueueList[0];
      setExportEnhanceSelectedPhotoId(nextId);
      setExportEnhanceSettings(cloneExportEnhanceSettings(exportEnhanceSettingsByPhoto[nextId] ?? defaultExportEnhanceSettings));
    }
  }, [exportEnhanceSelectedPhotoId, exportEnhanceSettingsByPhoto, exportQueueList]);

  useEffect(() => {
    if (activeTab !== "export-enhance") {
      setIsEnhancePreviewOpen(false);
    }
  }, [activeTab]);

  async function onStartExportEnhance() {
    if (!exportQueueList.length) {
      updateStatus("Add photos to the export queue before Enhance & Export.", "warn");
      return;
    }
    if (!exportEnhanceOutputFolder) {
      updateStatus("Choose an output folder before Enhance & Export.", "warn");
      return;
    }
    setIsStartingExportEnhance(true);
    updateStatus("Starting Enhance & Export...", "busy");
    try {
      const job = await createExportEnhanceJob({
        selectedIds: exportQueueList,
        outputFolder: exportEnhanceOutputFolder,
        settings: exportEnhanceSettings,
        settingsByPhoto: Object.fromEntries(exportQueueList.map(id => [id,
          id === exportEnhanceCurrentPhotoId ? exportEnhanceSettings : exportEnhanceSettingsByPhoto[id] ?? defaultExportEnhanceSettings]))
      });
      setExportEnhanceJob(job);
      updateStatus("Enhance & Export job started.", "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to start Enhance & Export", "error");
    } finally {
      setIsStartingExportEnhance(false);
    }
  }

  async function onResumeExportEnhance(retryFailed: boolean) {
    if (!exportEnhanceJob) return;
    try {
      setExportEnhanceJob(await resumeExportEnhanceJob(exportEnhanceJob.id, retryFailed));
      updateStatus(retryFailed ? "Retrying failed exports..." : "Resuming Enhance & Export...", "busy");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to resume Enhance & Export", "error");
    }
  }

  // After a restart, surface the last export if it was interrupted or left failures behind.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    void listExportEnhanceJobs(activeWorkspaceId)
      .then((jobs) => {
        const latest = jobs[0];
        if (!cancelled && latest && (latest.resumable || latest.failed > 0 || ["queued", "running"].includes(latest.status))) {
          setExportEnhanceJob((current) => current ?? latest);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  async function onCancelExportEnhance() {
    if (!exportEnhanceJob) return;
    try {
      setExportEnhanceJob(await cancelExportEnhanceJob(exportEnhanceJob.id));
      updateStatus("Enhance & Export cancellation requested.", "warn");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to cancel Enhance & Export", "error");
    }
  }

  useEffect(() => {
    if (!exportEnhanceJob || !["queued", "running"].includes(exportEnhanceJob.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void fetchExportEnhanceJob(exportEnhanceJob.id)
        .then((job) => {
          setExportEnhanceJob(job);
          if (job.status === "done") {
            updateStatus(`Enhance & Export complete: ${job.completed} file(s), ${job.failed} failed.`, job.failed ? "warn" : "ok");
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [exportEnhanceJob, updateStatus]);

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

  async function onInstallAiRuntime() {
    if (!window.aiCulling?.installAiRuntime) {
      updateStatus("AI runtime installer is only available in the desktop app.", "warn");
      return;
    }
    updateStatus("Installing AI runtime. This can take a while.", "busy");
    try {
      const status = await window.aiCulling.installAiRuntime();
      setAiRuntimeStatus(status);
      if (status.state === "error") {
        updateStatus(status.error || "AI runtime installation failed.", "error");
        return;
      }
      updateStatus(status.using ? "AI runtime is active." : "AI runtime installed.", "ok");
      await loadLibrary(activeWorkspaceId);
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to install AI runtime", "error");
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

  const switchTabByNumber = useCallback((index: number) => {
    const tab = WORKSPACE_TABS[index];
    if (!tab || tab === activeTab) {
      return false;
    }
    setActiveTab(tab);
    return true;
  }, [activeTab]);

  const appShortcutHandlers = useMemo<ShortcutHandlers>(() => ({
    "global.openPreview": () => {
      if (activeTab === "export-enhance") {
        if (!exportQueueList.length) return false;
        setIsEnhancePreviewOpen((open) => !open);
        return true;
      }
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
    },
    "global.showHelp": () => {
      setIsShortcutHelpOpen(true);
    },
    "global.previousPhoto": () => activeTab === "export-enhance" ? selectExportEnhanceDirection("left") : selectGlobalPhotoDirection("left"),
    "global.nextPhoto": () => activeTab === "export-enhance" ? selectExportEnhanceDirection("right") : selectGlobalPhotoDirection("right"),
    "global.photoDown": () => selectGlobalPhotoDirection("down"),
    "global.photoUp": () => selectGlobalPhotoDirection("up"),
    "global.switchTab1": () => switchTabByNumber(0),
    "global.switchTab2": () => switchTabByNumber(1),
    "global.switchTab3": () => switchTabByNumber(2),
    "global.switchTab4": () => switchTabByNumber(3),
    "global.switchTab5": () => switchTabByNumber(4),
    "global.switchTab6": () => switchTabByNumber(5),
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
  }), [activePhoto, activeTab, exportQueueIds, exportQueueList.length, isInspectorPreviewOpen, selectExportEnhanceDirection, selectGlobalPhotoDirection, selectSimilarityVerticalNeighbor, setActiveId, similarNavigation, switchTabByNumber, toggleExportQueue, updateStatus]);

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
      onRemoveVisibleFromQueue={removeVisibleFromQueue}
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
  } else if (activeTab === "export-enhance") {
    workspace = (
      <ExportEnhanceWorkspace
        photos={photos}
        queuedIds={exportQueueList}
        selectedPhotoId={exportEnhanceSelectedPhotoId}
        settings={exportEnhanceSettings}
        outputFolder={exportEnhanceOutputFolder}
        job={exportEnhanceJob}
        isStarting={isStartingExportEnhance}
        isPreviewOpen={isEnhancePreviewOpen}
        onPreviewOpenChange={setIsEnhancePreviewOpen}
        onSettingsChange={updateExportEnhanceSettings}
        canUndo={canUndoExportEnhance}
        onUndo={undoExportEnhanceSettings}
        saveState={enhanceSaveState}
        saveError={enhanceSaveError}
        onRetrySave={() => {
          if (!activeWorkspaceId) return;
          pendingEnhanceSaveRef.current = { id: activeWorkspaceId, settings: exportEnhanceSettingsByPhoto };
          setEnhanceSaveState("saving");
          flushEnhanceSave();
        }}
        canRedo={Boolean(exportEnhanceCurrentPhotoId && exportEnhanceRedoStacks[exportEnhanceCurrentPhotoId]?.length)}
        onRedo={redoExportEnhanceSettings}
        onBeginAdjustment={beginEnhanceGesture}
        onEndAdjustment={endEnhanceGesture}
        onApplyToQueued={applyAdjustmentsToQueue}
        onMatchExposure={matchQueueExposure}
        onApplyExposureMatches={applyExposureMatches}
        onReset={resetExportEnhanceSettings}
        onSelectPreviewPhoto={selectExportEnhancePhoto}
        onChooseFolder={() => void onChooseExportEnhanceFolder()}
        onOutputFolderChange={setExportEnhanceOutputFolder}
        onStart={() => void onStartExportEnhance()}
        onCancel={() => void onCancelExportEnhance()}
        onResume={(retryFailed) => void onResumeExportEnhance(retryFailed)}
        onClearQueue={clearExportQueue}
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
  } else if (activeTab === "settings") {
    workspace = (
      <SettingsWorkspace
        aiRuntimeStatus={aiRuntimeStatus}
        isRefreshing={isRefreshing}
        onRefresh={() => void onRefresh()}
        onInstallAiRuntime={() => void onInstallAiRuntime()}
        onShowOnboarding={() => setIsOnboardingOpen(true)}
      />
    );
  }

  const workspaceControls = (
    <section className="workspace-control-panel">
      <div className="side-section-head">
        <span className="panel-kicker">Workspace</span>
      </div>
      <select
        className="workspace-control-select ui-select"
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
          onWorkspaceDelete={(workspaceId) => {
            void onDeleteWorkspace(workspaceId);
          }}
          onWorkspaceRelocate={(workspaceId) => {
            void onRelocateWorkspace(workspaceId);
          }}
        />
        <ShortcutHelpDialog
          open={isShortcutHelpOpen}
          scopes={shortcutHelpScopes}
          onClose={() => setIsShortcutHelpOpen(false)}
        />
        <Onboarding
          open={isOnboardingOpen}
          aiRuntimeStatus={aiRuntimeStatus}
          onInstallAiRuntime={() => void onInstallAiRuntime()}
          onClose={() => setIsOnboardingOpen(false)}
        />
      </>
    );
  }

  return (
    <>
      <WorkspaceShell
        activeTab={activeTab}
        currentPath={activeWorkspace ? `${activeWorkspace.name} / ${activeFolder ? formatFolderLabel(activeFolder) : "All Photos"}` : "No Workspace"}
        isRefreshing={isRefreshing}
        isRescoring={isRescoring}
        backgroundProgress={backgroundProgress}
        aiRuntimeStatus={aiRuntimeStatus}
        onTabChange={setActiveTab}
        onRefresh={() => void onRefresh()}
        onRefreshScores={() => void onRefreshScores()}
        onInstallAiRuntime={() => void onInstallAiRuntime()}
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
              showPhotos={activeTab !== "browse"}
            />
          </>
        }
        inspector={activeTab === "export-enhance" ? null : (
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
        )}
      >
        <ErrorBoundary key={activeTab} label={WORKSPACE_LABELS[activeTab]}>
          {workspace}
        </ErrorBoundary>
      </WorkspaceShell>
      <ShortcutHelpDialog
        open={isShortcutHelpOpen}
        scopes={shortcutHelpScopes}
        onClose={() => setIsShortcutHelpOpen(false)}
      />
      <Onboarding
        open={isOnboardingOpen}
        aiRuntimeStatus={aiRuntimeStatus}
        onInstallAiRuntime={() => void onInstallAiRuntime()}
        onClose={() => setIsOnboardingOpen(false)}
      />
    </>
  );
}

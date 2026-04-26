import { useCallback, useState, type CSSProperties } from "react";
import { deletePhotos, exportPhotos, findSimilarPhotos, updatePhotoDecision, updatePhotoScore, uploadPhotos } from "./api";
import { LibraryBrowser } from "./components/library/LibraryBrowser";
import { InspectorPanel } from "./components/library/InspectorPanel";
import { Button } from "./components/ui/button";
import { useLibrary } from "./hooks/useLibrary";
import { usePhotoFilters } from "./hooks/usePhotoFilters";
import { usePhotoSelection } from "./hooks/usePhotoSelection";
import type { DecisionFilter, LibraryFolder, Photo, SimilarGroup, SortMode, StatusTone, ViewMode } from "./types";

function formatFolderLabel(folder: LibraryFolder): string {
  return folder.path ? folder.path : "Root";
}

export default function App() {
  const [search, setSearch] = useState("");
  const [minScore, setMinScore] = useState(70);
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortMode, setSortMode] = useState<SortMode>("score-desc");
  const [statusText, setStatusText] = useState("Ready");
  const [statusTone, setStatusTone] = useState<StatusTone>("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [similarGroups, setSimilarGroups] = useState<SimilarGroup[]>([]);
  const [similarDeleteIds, setSimilarDeleteIds] = useState<Set<string>>(new Set());
  const [isFindingSimilar, setIsFindingSimilar] = useState(false);
  const [isDeletingSimilar, setIsDeletingSimilar] = useState(false);

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
    refresh
  } = library;
  const selection = usePhotoSelection(photos, updateStatus);
  const { selectedIds, rejectedIds, setSelectedIds, setRejectedIds, toggleAccept, toggleReject } = selection;
  const { activeFolder, folderPhotos, visiblePhotos, activePhoto, childFolders } = usePhotoFilters(photos, folders, {
    activeFolderPath,
    search,
    minScore,
    decisionFilter,
    sortMode,
    selectedIds,
    rejectedIds,
    activeId
  });

  const keepRate = photos.length ? Math.round((visiblePhotos.length / photos.length) * 100) : 0;
  const rejectedCount = rejectedIds.size;
  const reviewedCount = selectedIds.size + rejectedIds.size;
  const reviewRate = photos.length ? Math.round((reviewedCount / photos.length) * 100) : 0;
  const completedCount = photos.filter((p) => p.status === "done" || p.status === "error").length;
  const processingTotal = photos.length;
  const processingInFlight = library.pendingCount + library.processingCount;
  const processingProgress = processingTotal
    ? Math.max(0, Math.min(100, Math.round((completedCount / processingTotal) * 100)))
    : 0;

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) {
      updateStatus("Choose at least one image before upload.", "warn");
      return;
    }

    updateStatus("Uploading and scoring photos...", "busy");
    try {
      await uploadPhotos(files);
      await loadLibrary();
      updateStatus("Library refreshed from uploads.", "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Upload failed", "error");
    }
  }

  async function saveScoreOverride(id: string, manualScore: number | null) {
    try {
      await updatePhotoScore(id, manualScore);
      await loadLibrary();
      updateStatus(manualScore === null ? "Manual score removed." : `Manual score set to ${manualScore}.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to update score", "error");
      throw err;
    }
  }

  function onAutoPickByScore() {
    if (!folderPhotos.length) {
      updateStatus("Open a folder with photos before running AI Pick.", "warn");
      return;
    }

    const scoreThreshold = minScore;
    const accepted = new Set(
      folderPhotos
        .filter((photo) => photo.status === "done" && photo.aiScore >= scoreThreshold)
        .map((photo) => photo.id)
    );
    const targetIds = new Set(folderPhotos.map((photo) => photo.id));
    const rejected = new Set(folderPhotos.filter((photo) => !accepted.has(photo.id)).map((photo) => photo.id));

    const previousSelected = new Set(selectedIds);
    const previousRejected = new Set(rejectedIds);

    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of targetIds) {
        next.delete(id);
      }
      for (const id of accepted) {
        next.add(id);
      }
      return next;
    });
    setRejectedIds((prev) => {
      const next = new Set(prev);
      for (const id of targetIds) {
        next.delete(id);
      }
      for (const id of rejected) {
        next.add(id);
      }
      return next;
    });

    void Promise.allSettled(
      folderPhotos.map((photo) =>
        updatePhotoDecision(photo.id, accepted.has(photo.id) ? "accepted" : "rejected")
      )
    ).then((results) => {
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) {
        setSelectedIds(previousSelected);
        setRejectedIds(previousRejected);
        updateStatus(`AI Pick failed to save ${failed} decision(s).`, "error");
        return;
      }

      if (accepted.size === 0) {
        updateStatus(`No photos met score >= ${scoreThreshold}; rejected ${rejected.size} photo(s).`, "warn");
        return;
      }

      updateStatus(`AI Pick accepted ${accepted.size} photo(s) and rejected ${rejected.size}.`, "ok");
    });
  }

  async function onExport() {
    if (!selectedIds.size) {
      updateStatus("Select photos before exporting.", "warn");
      return;
    }

    updateStatus("Building ZIP export...", "busy");
    try {
      const blob = await exportPhotos([...selectedIds]);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "selected.zip";
      a.click();
      window.URL.revokeObjectURL(url);
      updateStatus(`Exported ${selectedIds.size} photos.`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Export failed", "error");
    }
  }

  async function onRefresh() {
    updateStatus("Refreshing library and rescanning uploads...", "busy");
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
    updateStatus("Finding similar photos...", "busy");
    setIsFindingSimilar(true);
    try {
      const payload = await findSimilarPhotos(6);
      const photoMap = new Map(photos.map((photo) => [photo.id, photo]));
      const groups = payload.groups
        .map((group) => ({
          id: group.id,
          maxDistance: group.maxDistance,
          photos: group.photoIds
            .map((id) => photoMap.get(id))
            .filter((photo): photo is Photo => Boolean(photo))
            .sort((a, b) => b.aiScore - a.aiScore)
        }))
        .filter((group) => group.photos.length > 1);
      setSimilarGroups(groups);
      setSimilarDeleteIds(new Set(groups.flatMap((group) => group.photos.slice(1).map((photo) => photo.id))));
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
    const confirmed = window.confirm(`Delete ${count} photo(s) from disk and the library? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    updateStatus(`Deleting ${count} photo(s)...`, "busy");
    setIsDeletingSimilar(true);
    try {
      const result = await deletePhotos([...similarDeleteIds]);
      setSimilarDeleteIds(new Set());
      setSimilarGroups([]);
      await loadLibrary();
      updateStatus(`Deleted ${result.deletedRecords} photo(s) and ${result.deletedFiles} file(s).`, "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to delete photos", "error");
    } finally {
      setIsDeletingSimilar(false);
    }
  }

  return (
    <div className="shell">
      <header className="hero">
        <div>
          <h1>AI Photo Culling</h1>
          <p>Finder-style folder browsing with score-based color labels and multiple sort modes.</p>
        </div>
        <div className="hero-actions">
          <label className="hero-action hero-action-upload" htmlFor="fileInput">Upload Photos</label>
          <input
            id="fileInput"
            type="file"
            multiple
            accept="image/*"
            hidden
            onChange={(e) => void onUpload(e.target.files)}
          />
          <Button variant="outline" className="hero-action hero-action-refresh" onClick={() => void onRefresh()} disabled={isRefreshing}>{isRefreshing ? "Refreshing..." : "Refresh"}</Button>
          <Button variant="default" className="hero-action hero-action-export" onClick={() => void onExport()}>Export Selects</Button>
        </div>
      </header>

      <main className="layout">
        <LibraryBrowser
          folders={folders}
          activeFolder={activeFolder}
          activeFolderPath={activeFolderPath}
          childFolders={childFolders}
          visiblePhotos={visiblePhotos}
          selectedIds={selectedIds}
          activePhotoId={activePhoto?.id ?? null}
          viewMode={viewMode}
          sortMode={sortMode}
          search={search}
          minScore={minScore}
          decisionFilter={decisionFilter}
          statusText={statusText}
          statusTone={statusTone}
          keepRate={keepRate}
          folderPhotosCount={folderPhotos.length}
          similarGroups={similarGroups}
          similarDeleteIds={similarDeleteIds}
          isFindingSimilar={isFindingSimilar}
          isDeletingSimilar={isDeletingSimilar}
          onSearchChange={setSearch}
          onMinScoreChange={setMinScore}
          onDecisionFilterChange={setDecisionFilter}
          onSortModeChange={setSortMode}
          onViewModeChange={setViewMode}
          onSelectFolder={setActiveFolderPath}
          onSelectPhoto={setActiveId}
          rejectedIds={rejectedIds}
          onToggleAccept={toggleAccept}
          onToggleReject={toggleReject}
          onAutoPickByScore={onAutoPickByScore}
          onFindSimilar={onFindSimilar}
          onToggleSimilarDelete={onToggleSimilarDelete}
          onDeleteSimilarSelected={onDeleteSimilarSelected}
        />

        <aside className="stack">
          <InspectorPanel
            activePhoto={activePhoto}
            selectedIds={selectedIds}
            rejectedIds={rejectedIds}
            onToggleAccept={toggleAccept}
            onToggleReject={toggleReject}
            onSaveScoreOverride={saveScoreOverride}
          />
        </aside>
      </main>

      <aside className={`card filters stats-dock ${isStatsOpen ? "open" : "collapsed"}`.trim()}>
        <button className="stats-toggle" onClick={() => setIsStatsOpen((prev) => !prev)}>
          <div className="stats-toggle-copy">
            <span className="stats-eyebrow">Live Stats</span>
            <strong>Curation Pulse</strong>
          </div>
          <div className="stats-toggle-chip">
            <span className="stats-summary">Review {reviewRate}%</span>
          </div>
          <span className="stats-caret" aria-hidden="true">{isStatsOpen ? "▾" : "▸"}</span>
        </button>

        {isStatsOpen ? (
          <div className="stats-body">
            <section className="stats-hero">
              <div className="stats-hero-copy">
                <span className="stats-eyebrow">Review coverage</span>
                <div className="stats-hero-value">
                  <strong>{reviewRate}%</strong>
                  <span>{reviewedCount}/{photos.length || 0} frames reviewed</span>
                </div>
                <p>{selectedIds.size} accepted · {rejectedCount} rejected across the library.</p>
              </div>
              <div
                className="stats-ring"
                style={{ "--ring-value": reviewRate * 3.6 } as CSSProperties}
                aria-hidden="true"
              >
                <div className="stats-ring-inner">
                  <span>Review</span>
                  <strong>{reviewRate}%</strong>
                </div>
              </div>
            </section>

            <div className="stats-grid">
              <article className="mini-stat mini-stat-accent">
                <span>Visible Now</span>
                <strong>{visiblePhotos.length}</strong>
                <small>after filters</small>
              </article>
              <article className="mini-stat">
                <span>Selected</span>
                <strong>{selectedIds.size}</strong>
                <small>keepers marked</small>
              </article>
              <article className="mini-stat">
                <span>Rejected</span>
                <strong>{rejectedCount}</strong>
                <small>set aside</small>
              </article>
              <article className="mini-stat">
                <span>In Queue</span>
                <strong>{processingInFlight}</strong>
                <small>still scoring</small>
              </article>
            </div>

            <section className="stats-panel">
              <div className="stats-panel-head">
                <div>
                  <span className="stats-eyebrow">Current Folder</span>
                  <strong>{activeFolder ? formatFolderLabel(activeFolder) : "Root"}</strong>
                </div>
                <span className="stats-panel-chip">{keepRate}% keep rate</span>
              </div>
              <div className="stats-progress-group">
                <div className="progress-head">
                  <span>Filter retention</span>
                  <span>{visiblePhotos.length}/{photos.length || 0}</span>
                </div>
                <div className="progress progress-retention">
                  <span style={{ width: `${keepRate}%` }} />
                </div>
              </div>
              <div className="stats-progress-group">
                <div className="progress-head">
                  <span>Background scoring</span>
                  <span>{processingProgress}%</span>
                </div>
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={processingProgress}>
                  <span style={{ width: `${processingProgress}%` }} />
                </div>
              </div>
              <div className="progress-meta">
                <span>{completedCount}/{processingTotal} completed</span>
                <span>{processingInFlight} in queue</span>
              </div>
            </section>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

import { useCallback, useState, type CSSProperties } from "react";
import { deletePhotos, exportPhotos, findSimilarPhotos, updatePhotoRating, updatePhotoScore, uploadPhotos } from "./api";
import { LibraryBrowser } from "./components/library/LibraryBrowser";
import { InspectorPanel } from "./components/library/InspectorPanel";
import { Button } from "./components/ui/button";
import { useLibrary } from "./hooks/useLibrary";
import { usePhotoFilters } from "./hooks/usePhotoFilters";
import { usePhotoRatings } from "./hooks/usePhotoRatings";
import type { LibraryFolder, Photo, RatingFilter, SimilarGroup, SortMode, StatusTone, ViewMode } from "./types";

function formatFolderLabel(folder: LibraryFolder): string {
  return folder.path ? folder.path : "Root";
}

export default function App() {
  const [search, setSearch] = useState("");
  const [minScore, setMinScore] = useState(70);
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
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
    refresh
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

  const keepRate = photos.length ? Math.round((visiblePhotos.length / photos.length) * 100) : 0;
  const ratedCount = ratings.size;
  const exportIds = photos.filter((photo) => (ratings.get(photo.id) ?? photo.rating ?? 0) >= 4).map((photo) => photo.id);
  const reviewRate = photos.length ? Math.round((ratedCount / photos.length) * 100) : 0;
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
    if (!exportIds.length) {
      updateStatus("Rate photos 4 or 5 stars before exporting.", "warn");
      return;
    }

    updateStatus("Building ZIP export...", "busy");
    try {
      const blob = await exportPhotos(exportIds);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "selected.zip";
      a.click();
      window.URL.revokeObjectURL(url);
      updateStatus(`Exported ${exportIds.length} 4+ star photo(s).`, "ok");
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
      const payload = await findSimilarPhotos(true);
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
      setSimilarSummary("");
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
          <Button variant="default" className="hero-action hero-action-export" onClick={() => void onExport()}>Export 4+ Stars</Button>
        </div>
      </header>

      <main className="layout">
        <LibraryBrowser
          folders={folders}
          activeFolder={activeFolder}
          activeFolderPath={activeFolderPath}
          visiblePhotos={visiblePhotos}
          ratings={ratings}
          activePhotoId={activePhoto?.id ?? null}
          viewMode={viewMode}
          sortMode={sortMode}
          search={search}
          minScore={minScore}
          ratingFilter={ratingFilter}
          statusText={statusText}
          statusTone={statusTone}
          keepRate={keepRate}
          folderPhotosCount={folderPhotos.length}
          similarGroups={similarGroups}
          similarDeleteIds={similarDeleteIds}
          isFindingSimilar={isFindingSimilar}
          isDeletingSimilar={isDeletingSimilar}
          similarSummary={similarSummary}
          onSearchChange={setSearch}
          onMinScoreChange={setMinScore}
          onRatingFilterChange={setRatingFilter}
          onSortModeChange={setSortMode}
          onViewModeChange={setViewMode}
          onSelectFolder={setActiveFolderPath}
          onSelectPhoto={setActiveId}
          onRatePhoto={ratePhoto}
          onAutoRateByScore={onAutoRateByScore}
          onFindSimilar={onFindSimilar}
          onToggleSimilarDelete={onToggleSimilarDelete}
          onDeleteSimilarSelected={onDeleteSimilarSelected}
        />

        <aside className="stack">
          <InspectorPanel
            activePhoto={activePhoto}
            ratings={ratings}
            onRatePhoto={ratePhoto}
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
            <span className="stats-summary">Rated {reviewRate}%</span>
          </div>
          <span className="stats-caret" aria-hidden="true">{isStatsOpen ? "▾" : "▸"}</span>
        </button>

        {isStatsOpen ? (
          <div className="stats-body">
            <section className="stats-hero">
              <div className="stats-hero-copy">
                <span className="stats-eyebrow">Rating coverage</span>
                <div className="stats-hero-value">
                  <strong>{reviewRate}%</strong>
                  <span>{ratedCount}/{photos.length || 0} frames rated</span>
                </div>
                <p>{exportIds.length} photos are 4+ stars and ready for export.</p>
              </div>
              <div
                className="stats-ring"
                style={{ "--ring-value": reviewRate * 3.6 } as CSSProperties}
                aria-hidden="true"
              >
                <div className="stats-ring-inner">
                  <span>Rated</span>
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
                <span>4+ Stars</span>
                <strong>{exportIds.length}</strong>
                <small>export-ready</small>
              </article>
              <article className="mini-stat">
                <span>Rated</span>
                <strong>{ratedCount}</strong>
                <small>starred frames</small>
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

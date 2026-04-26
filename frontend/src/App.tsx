import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { exportPhotos, fetchLibrary, refreshLibrary, updatePhotoDecision, updatePhotoScore, uploadPhotos } from "./api";
import { normalizeScores } from "./core";
import { LibraryBrowser } from "./components/library/LibraryBrowser";
import { InspectorPanel } from "./components/library/InspectorPanel";
import { Button } from "./components/ui/button";
import type { DecisionFilter, LibraryFolder, Photo, SortMode, StatusTone, ViewMode } from "./types";

function formatFolderLabel(folder: LibraryFolder): string {
  return folder.path ? folder.path : "Root";
}

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeFolderPath, setActiveFolderPath] = useState<string>("");
  const [search, setSearch] = useState("");
  const [minScore, setMinScore] = useState(70);
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortMode, setSortMode] = useState<SortMode>("score-desc");
  const [statusText, setStatusText] = useState("Ready");
  const [statusTone, setStatusTone] = useState<StatusTone>("");
  const [pendingCount, setPendingCount] = useState(0);
  const [processingCount, setProcessingCount] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStatsOpen, setIsStatsOpen] = useState(false);

  function updateStatus(text: string, tone: StatusTone = "") {
    setStatusText(text);
    setStatusTone(tone);
  }

  async function loadLibrary() {
    try {
      const data = await fetchLibrary();
      applyLibraryPayload(data);
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Failed to load library", "error");
    }
  }

  function applyLibraryPayload(data: Awaited<ReturnType<typeof fetchLibrary>>) {
    const normalized = normalizeScores(data.photos);
    setPhotos(normalized);
    setSelectedIds(new Set(normalized.filter((photo) => photo.decision === "accepted").map((photo) => photo.id)));
    setRejectedIds(new Set(normalized.filter((photo) => photo.decision === "rejected").map((photo) => photo.id)));
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

    if (data.summary.processing > 0 || data.summary.pending > 0) {
      updateStatus(
        `Scoring in background: ${data.summary.processing} processing, ${data.summary.pending} queued`,
        "busy"
      );
    } else if (data.summary.error > 0) {
      updateStatus(`Loaded ${normalized.length} photos (${data.summary.error} failed).`, "warn");
    } else {
      updateStatus(`Loaded ${normalized.length} photos from uploads.`, "ok");
    }
  }

  useEffect(() => {
    void loadLibrary();
  }, []);

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
  }, [pendingCount, processingCount]);

  const activeFolder = useMemo(
    () => folders.find((folder) => folder.path === activeFolderPath) ?? folders[0] ?? null,
    [folders, activeFolderPath]
  );

  const folderPhotos = useMemo(() => {
    if (!activeFolder) {
      return [];
    }

    return photos.filter((photo) => photo.folderPath === activeFolder.path);
  }, [photos, activeFolder]);

  const visiblePhotos = useMemo(() => {
    let items = folderPhotos.filter((photo) => {
      if (photo.aiScore < minScore) return false;
      if (search && !photo.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (decisionFilter === "accepted" && !selectedIds.has(photo.id)) return false;
      if (decisionFilter === "rejected" && !rejectedIds.has(photo.id)) return false;
      return true;
    });

    const sorter: Record<SortMode, (a: Photo, b: Photo) => number> = {
      "score-desc": (a, b) => b.aiScore - a.aiScore,
      "score-asc": (a, b) => a.aiScore - b.aiScore,
      "name-asc": (a, b) => a.name.localeCompare(b.name),
      "name-desc": (a, b) => b.name.localeCompare(a.name),
      "mtime-desc": (a, b) => b.mtime - a.mtime,
      "mtime-asc": (a, b) => a.mtime - b.mtime
    };

    return [...items].sort(sorter[sortMode]);
  }, [folderPhotos, minScore, search, decisionFilter, selectedIds, rejectedIds, sortMode]);

  const activePhoto = useMemo(
    () => photos.find((p) => p.id === activeId) ?? visiblePhotos[0] ?? null,
    [photos, activeId, visiblePhotos]
  );

  const childFolders = folders.filter((folder) => folder.path.startsWith(activeFolderPath ? `${activeFolderPath}/` : "") && folder.path !== activeFolderPath);
  const keepRate = photos.length ? Math.round((visiblePhotos.length / photos.length) * 100) : 0;
  const rejectedCount = rejectedIds.size;
  const reviewedCount = selectedIds.size + rejectedIds.size;
  const reviewRate = photos.length ? Math.round((reviewedCount / photos.length) * 100) : 0;
  const completedCount = photos.filter((p) => p.status === "done" || p.status === "error").length;
  const processingTotal = photos.length;
  const processingInFlight = pendingCount + processingCount;
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

  function setDecisionLocal(id: string, decision: "accepted" | "rejected" | null) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (decision === "accepted") {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    setRejectedIds((prev) => {
      const next = new Set(prev);
      if (decision === "rejected") {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  async function saveDecision(id: string, decision: "accepted" | "rejected" | null) {
    const previousAccepted = selectedIds.has(id);
    const previousRejected = rejectedIds.has(id);
    setDecisionLocal(id, decision);
    try {
      await updatePhotoDecision(id, decision);
    } catch (err) {
      if (previousAccepted) {
        setDecisionLocal(id, "accepted");
      } else if (previousRejected) {
        setDecisionLocal(id, "rejected");
      } else {
        setDecisionLocal(id, null);
      }
      updateStatus(err instanceof Error ? err.message : "Failed to save decision", "error");
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

  function toggleAccept(id: string) {
    const next = selectedIds.has(id) ? null : "accepted";
    void saveDecision(id, next);
  }

  function toggleReject(id: string) {
    const next = rejectedIds.has(id) ? null : "rejected";
    void saveDecision(id, next);
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
      const data = await refreshLibrary();
      applyLibraryPayload(data);
      updateStatus("Refresh complete.", "ok");
    } catch (err) {
      updateStatus(err instanceof Error ? err.message : "Refresh failed", "error");
    } finally {
      setIsRefreshing(false);
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

          <section className="card smart">
            <h2>Smart Actions</h2>
            <div className="smart-item">AI Pick selects strong frames and rejects the rest of the current view.</div>
            <div className="smart-item">Hide weak shots below your quality threshold.</div>
            <div className="smart-item">Export only selected keepers as ZIP.</div>
          </section>
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

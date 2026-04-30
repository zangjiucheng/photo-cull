import { useEffect, useState } from "react";
import type { Photo } from "../../types";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface InspectorPanelProps {
  activePhoto: Photo | null;
  ratings: Map<string, number>;
  exportQueueIds: Set<string>;
  similarNavigation?: {
    current: number;
    total: number;
    groupLabel: string;
    previousId: string | null;
    nextId: string | null;
    canRemove: boolean;
    isMarkedForRemoval: boolean;
  } | null;
  onRatePhoto: (id: string, rating: number) => void;
  onToggleExportQueue: (id: string) => void;
  onSelectPhoto: (id: string) => void;
  onToggleSimilarRemove?: (id: string) => void;
  onSaveScoreOverride: (id: string, manualScore: number | null) => Promise<void>;
  onSaveOrientationOverride: (id: string, orientationOverride: 0 | 90 | 180 | 270 | null) => Promise<void>;
}

function StarRating({
  photo,
  rating,
  onRatePhoto
}: {
  photo: Photo;
  rating: number;
  onRatePhoto: (id: string, rating: number) => void;
}) {
  const [hoverRating, setHoverRating] = useState(0);
  const previewRating = hoverRating || rating;

  return (
    <div className="star-rating" aria-label={`Rating ${rating || "unrated"} out of 5`} onMouseLeave={() => setHoverRating(0)}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          className={`star-btn ${previewRating >= star ? "filled" : ""}`.trim()}
          onMouseEnter={() => setHoverRating(star)}
          onFocus={() => setHoverRating(star)}
          onBlur={() => setHoverRating(0)}
          onClick={() => onRatePhoto(photo.id, star)}
          aria-label={`Set ${star} star${star === 1 ? "" : "s"}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function formatScoreValue(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(digits).replace(/\.0$/, "");
}

function scoreQualityLabel(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "Unknown";
  if (value >= 82) return "Strong";
  if (value >= 70) return "Good";
  if (value >= 50) return "Review";
  return "Weak";
}

function ScoreReasonPanel({ photo }: { photo: Photo }) {
  const details = photo.scoreDetails;
  const metrics = Object.entries(details?.metrics ?? {})
    .sort(([, a], [, b]) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
  const heuristics = details?.heuristics ?? null;
  const errors = Object.entries(details?.errors ?? {}).filter(([, message]) => message);

  if (!details) {
    return (
      <div className="score-reason-card">
        <div className="score-reason-head">
          <div>
            <span className="score-override-label">Score Reasons</span>
            <strong>No details yet</strong>
          </div>
        </div>
        <p className="score-reason-empty">
          {photo.status === "done" ? "Refresh AI scores to generate detailed reasons for this photo." : "Details will appear after backend scoring finishes."}
        </p>
      </div>
    );
  }

  return (
    <div className="score-reason-card">
      <div className="score-reason-head">
        <div>
          <span className="score-override-label">Score Reasons</span>
          <strong>{details.mode || "AI scoring"} · Final {formatScoreValue(details.final ?? photo.score ?? undefined)}</strong>
        </div>
        <span className="score-reason-pill">{scoreQualityLabel(details.final ?? photo.score ?? undefined)}</span>
      </div>

      {metrics.length ? (
        <div className="score-reason-section">
          <span className="score-reason-section-title">Model metrics</span>
          <div className="score-reason-list">
            {metrics.map(([name, metric]) => {
              const normalized = typeof metric.normalized === "number" ? metric.normalized : undefined;
              return (
                <div className={`score-reason-row ${metric.status === "error" ? "error" : ""}`.trim()} key={name}>
                  <div>
                    <strong>{name}</strong>
                    <span>
                      {metric.group || "metric"}
                      {typeof metric.weight === "number" ? ` · weight ${formatScoreValue(metric.weight, 2)}` : ""}
                      {metric.lowerBetter ? " · lower is better" : ""}
                    </span>
                  </div>
                  <div className="score-reason-value">
                    <strong>{metric.status === "error" ? "Error" : formatScoreValue(normalized)}</strong>
                    <span>{metric.status === "error" ? metric.error || "Metric failed" : `raw ${formatScoreValue(metric.raw, 3)}`}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {heuristics ? (
        <div className="score-reason-section">
          <span className="score-reason-section-title">Photo signals</span>
          <div className="score-signal-grid">
            <div><span>Sharpness</span><strong>{formatScoreValue(heuristics.sharpness)}</strong></div>
            <div><span>Exposure</span><strong>{formatScoreValue(heuristics.exposure)}</strong></div>
            <div><span>Contrast</span><strong>{formatScoreValue(heuristics.contrast)}</strong></div>
            <div><span>Clipping</span><strong>{formatScoreValue(heuristics.clipping)}</strong></div>
            <div><span>Brightness</span><strong>{formatScoreValue(heuristics.brightness, 3)}</strong></div>
            <div><span>Clipped</span><strong>{formatScoreValue((heuristics.clippedRatio ?? 0) * 100, 2)}%</strong></div>
          </div>
        </div>
      ) : null}

      {errors.length ? (
        <div className="score-reason-section">
          <span className="score-reason-section-title">Scoring errors</span>
          <div className="score-error-list">
            {errors.map(([name, message]) => <span key={name}>{name}: {message}</span>)}
          </div>
        </div>
      ) : null}

      {details.raw ? <p className="score-reason-empty">{details.raw}</p> : null}
    </div>
  );
}

export function InspectorPanel({
  activePhoto,
  ratings,
  exportQueueIds,
  similarNavigation,
  onRatePhoto,
  onToggleExportQueue,
  onSelectPhoto,
  onToggleSimilarRemove,
  onSaveScoreOverride,
  onSaveOrientationOverride
}: InspectorPanelProps) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [scoreDraft, setScoreDraft] = useState("");
  const [isSavingScore, setIsSavingScore] = useState(false);
  const [isSavingOrientation, setIsSavingOrientation] = useState(false);

  useEffect(() => {
    if (!activePhoto) {
      setIsPreviewOpen(false);
      setScoreDraft("");
      return;
    }
    setScoreDraft(
      activePhoto.manualScore !== null && activePhoto.manualScore !== undefined
        ? String(activePhoto.manualScore)
        : String(activePhoto.aiScore)
    );
  }, [activePhoto]);

  useEffect(() => {
    if (!isPreviewOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsPreviewOpen(false);
        return;
      }
      if (event.key === "ArrowLeft" && similarNavigation?.previousId) {
        event.preventDefault();
        onSelectPhoto(similarNavigation.previousId);
        return;
      }
      if (event.key === "ArrowRight" && similarNavigation?.nextId) {
        event.preventDefault();
        onSelectPhoto(similarNavigation.nextId);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isPreviewOpen, onSelectPhoto, similarNavigation]);

  async function handleSaveScoreOverride() {
    if (!activePhoto) {
      return;
    }

    const trimmed = scoreDraft.trim();
    const nextValue = trimmed === "" ? null : Number(trimmed);
    if (trimmed !== "" && !Number.isFinite(nextValue)) {
      return;
    }
    if (nextValue !== null && (nextValue < 0 || nextValue > 100)) {
      return;
    }

    setIsSavingScore(true);
    try {
      await onSaveScoreOverride(activePhoto.id, nextValue);
    } finally {
      setIsSavingScore(false);
    }
  }

  async function handleResetScoreOverride() {
    if (!activePhoto) {
      return;
    }
    setIsSavingScore(true);
    try {
      await onSaveScoreOverride(activePhoto.id, null);
      setScoreDraft(String(activePhoto.aiScore));
    } finally {
      setIsSavingScore(false);
    }
  }

  async function handleOrientationChange(orientationOverride: 0 | 90 | 180 | 270 | null) {
    if (!activePhoto) {
      return;
    }
    setIsSavingOrientation(true);
    try {
      await onSaveOrientationOverride(activePhoto.id, orientationOverride);
    } finally {
      setIsSavingOrientation(false);
    }
  }

  return (
    <>
      <Card className="inspector-card">
        <CardHeader>
          <CardTitle>Inspector</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!activePhoto && <div className="inspector-empty">Open a folder and pick a photo.</div>}
          {activePhoto && (
            <>
              <button
                type="button"
                className="inspect-image"
                onClick={() => setIsPreviewOpen(true)}
                aria-label={`Open preview for ${activePhoto.name}`}
              >
                <img src={activePhoto.url} alt={activePhoto.name} />
                <span className="inspect-image-hint">Click to enlarge</span>
              </button>
              <div className="inspect-meta">
                <h3>{activePhoto.name}</h3>
                <p>Folder: {activePhoto.folder || "Root"}</p>
                <StarRating
                  photo={activePhoto}
                  rating={ratings.get(activePhoto.id) ?? activePhoto.rating ?? 0}
                  onRatePhoto={onRatePhoto}
                />
                <Button
                  className="inspector-queue-button inspector-queue-under-stars"
                  variant={exportQueueIds.has(activePhoto.id) ? "secondary" : "outline"}
                  onClick={() => onToggleExportQueue(activePhoto.id)}
                >
                  {exportQueueIds.has(activePhoto.id) ? "In Queue" : "Add Queue"}
                </Button>
                <div className="metric-grid">
                  <div className="metric"><span>AI Score</span><strong>{activePhoto.aiScore}</strong></div>
                  <div className="metric"><span>Raw Score</span><strong>{activePhoto.score ?? "-"}</strong></div>
                </div>
                <ScoreReasonPanel photo={activePhoto} />
                <div className="score-override-card">
                  <div className="score-override-head">
                    <div>
                      <span className="score-override-label">Manual Override</span>
                      <strong>{activePhoto.manualScore !== null ? `Using ${activePhoto.manualScore}` : "Using auto score"}</strong>
                    </div>
                    {activePhoto.manualScore !== null ? <span className="score-override-badge">Override On</span> : null}
                  </div>
                  <div className="score-override-controls">
                    <input
                      className="score-override-input"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={scoreDraft}
                      onChange={(event) => setScoreDraft(event.target.value)}
                      placeholder="0-100"
                    />
                    <Button className="score-override-action" variant="outline" onClick={() => void handleSaveScoreOverride()} disabled={isSavingScore}>
                      {isSavingScore ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      className="score-override-action"
                      variant="ghost"
                      onClick={() => void handleResetScoreOverride()}
                      disabled={isSavingScore || activePhoto.manualScore === null}
                    >
                      Reset
                    </Button>
                  </div>
                </div>
                {activePhoto.status !== "done" && (
                  <div className="tab-body">
                    {activePhoto.status === "pending" && "Waiting in backend queue."}
                    {activePhoto.status === "processing" && "Scoring in backend worker."}
                    {activePhoto.status === "error" && (activePhoto.error || "Scoring failed.")}
                  </div>
                )}
                <div className="orientation-override-card">
                  <div className="orientation-override-head">
                    <div>
                      <span className="score-override-label">Orientation</span>
                      <strong>{activePhoto.orientationOverride ? `${activePhoto.orientationOverride} deg clockwise` : "Using EXIF orientation"}</strong>
                    </div>
                    {activePhoto.orientationOverride ? <span className="score-override-badge">Override On</span> : null}
                  </div>
                  <div className="orientation-override-controls" aria-label="Orientation override">
                    {[0, 90, 180, 270].map((degrees) => {
                      const value = degrees as 0 | 90 | 180 | 270;
                      const isActive = (activePhoto.orientationOverride ?? 0) === value;
                      return (
                        <Button
                          key={degrees}
                          className="orientation-override-button"
                          variant={isActive ? "secondary" : "outline"}
                          onClick={() => void handleOrientationChange(value === 0 ? null : value)}
                          disabled={isSavingOrientation}
                        >
                          {degrees}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {activePhoto && isPreviewOpen ? (
        <div className="inspector-lightbox" role="dialog" aria-modal="true" aria-label={`${activePhoto.name} preview`} onClick={() => setIsPreviewOpen(false)}>
          <div className="inspector-lightbox-panel" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="inspector-lightbox-close"
              onClick={() => setIsPreviewOpen(false)}
              aria-label="Close preview"
            >
              ×
            </button>
            <img className="inspector-lightbox-image" src={activePhoto.url} alt={activePhoto.name} />
            <div className="inspector-lightbox-actions">
              {similarNavigation && onToggleSimilarRemove ? (
                <Button
                  variant={similarNavigation.isMarkedForRemoval ? "destructive" : "outline"}
                  size="sm"
                  disabled={!similarNavigation.canRemove}
                  onClick={() => onToggleSimilarRemove(activePhoto.id)}
                >
                  {similarNavigation.isMarkedForRemoval ? "Marked Remove" : similarNavigation.canRemove ? "Remove" : "Keep"}
                </Button>
              ) : null}
              <Button
                variant={exportQueueIds.has(activePhoto.id) ? "secondary" : "outline"}
                size="sm"
                onClick={() => onToggleExportQueue(activePhoto.id)}
              >
                {exportQueueIds.has(activePhoto.id) ? "In Queue" : "Queue"}
              </Button>
            </div>
            {similarNavigation ? (
              <>
                <button
                  type="button"
                  className="inspector-lightbox-nav previous"
                  disabled={!similarNavigation.previousId}
                  onClick={() => similarNavigation.previousId && onSelectPhoto(similarNavigation.previousId)}
                  aria-label="Previous similar photo"
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="inspector-lightbox-nav next"
                  disabled={!similarNavigation.nextId}
                  onClick={() => similarNavigation.nextId && onSelectPhoto(similarNavigation.nextId)}
                  aria-label="Next similar photo"
                >
                  ›
                </button>
                <div className="inspector-lightbox-counter">
                  {similarNavigation.groupLabel} · {similarNavigation.current}/{similarNavigation.total}
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

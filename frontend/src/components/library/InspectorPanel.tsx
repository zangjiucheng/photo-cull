import { useEffect, useMemo, useRef, useState } from "react";
import { shortcutRegistry } from "../../shortcuts/registry";
import type { ShortcutHandlers } from "../../shortcuts/types";
import { useShortcuts } from "../../shortcuts/useShortcuts";
import type { Photo } from "../../types";
import { Button } from "../ui/button";

interface InspectorPanelProps {
  activePhoto: Photo | null;
  ratings: Map<string, number>;
  exportQueueIds: Set<string>;
  openPreviewSignal?: number;
  shortcutsDisabled?: boolean;
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
  onPreviewOpenChange?: (isOpen: boolean) => void;
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
      <section className="inspect-section">
        <div className="inspect-section-head">
          <span className="panel-kicker">Score Reasons</span>
          <span className="inspect-section-note">No details yet</span>
        </div>
        <p className="inspect-note">
          {photo.status === "done" ? "Refresh AI scores to generate detailed reasons for this photo." : "Details will appear after backend scoring finishes."}
        </p>
      </section>
    );
  }

  const finalScore = details.final ?? photo.score ?? undefined;

  return (
    <>
      <section className="inspect-section">
        <div className="inspect-section-head">
          <span className="panel-kicker">Score Reasons</span>
          <span className="inspect-section-note">{scoreQualityLabel(finalScore)}</span>
        </div>
        <dl className="inspect-list">
          <div className="inspect-row"><dt>Mode</dt><dd>{details.mode || "AI scoring"}</dd></div>
          <div className="inspect-row"><dt>Final</dt><dd className="num">{formatScoreValue(finalScore)}</dd></div>
        </dl>
      </section>

      {metrics.length ? (
        <section className="inspect-section">
          <div className="inspect-section-head"><span className="panel-kicker">Model metrics</span></div>
          <dl className="inspect-list">
            {metrics.map(([name, metric]) => {
              const normalized = typeof metric.normalized === "number" ? metric.normalized : undefined;
              const isError = metric.status === "error";
              return (
                <div className={`inspect-row inspect-metric ${isError ? "error" : ""}`.trim()} key={name}>
                  <dt>
                    <span className="inspect-metric-name">{name}</span>
                    <span className="inspect-sub">
                      {metric.group || "metric"}
                      {typeof metric.weight === "number" ? ` · weight ${formatScoreValue(metric.weight, 2)}` : ""}
                      {metric.lowerBetter ? " · lower is better" : ""}
                    </span>
                  </dt>
                  <dd>
                    <span className="num">{isError ? "Error" : formatScoreValue(normalized)}</span>
                    <span className="inspect-sub num">{isError ? metric.error || "Metric failed" : `raw ${formatScoreValue(metric.raw, 3)}`}</span>
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ) : null}

      {heuristics ? (
        <section className="inspect-section">
          <div className="inspect-section-head"><span className="panel-kicker">Photo signals</span></div>
          <dl className="inspect-list">
            <div className="inspect-row"><dt>Sharpness</dt><dd className="num">{formatScoreValue(heuristics.sharpness)}</dd></div>
            <div className="inspect-row"><dt>Exposure</dt><dd className="num">{formatScoreValue(heuristics.exposure)}</dd></div>
            <div className="inspect-row"><dt>Contrast</dt><dd className="num">{formatScoreValue(heuristics.contrast)}</dd></div>
            <div className="inspect-row"><dt>Clipping</dt><dd className="num">{formatScoreValue(heuristics.clipping)}</dd></div>
            <div className="inspect-row"><dt>Brightness</dt><dd className="num">{formatScoreValue(heuristics.brightness, 3)}</dd></div>
            <div className="inspect-row"><dt>Clipped</dt><dd className="num">{formatScoreValue((heuristics.clippedRatio ?? 0) * 100, 2)}%</dd></div>
          </dl>
        </section>
      ) : null}

      {errors.length ? (
        <section className="inspect-section">
          <div className="inspect-section-head"><span className="panel-kicker">Scoring errors</span></div>
          <div className="inspect-errors">
            {errors.map(([name, message]) => <span key={name}>{name}: {message}</span>)}
          </div>
        </section>
      ) : null}

      {details.raw ? <p className="inspect-note">{details.raw}</p> : null}
    </>
  );
}

export function InspectorPanel({
  activePhoto,
  ratings,
  exportQueueIds,
  openPreviewSignal = 0,
  shortcutsDisabled = false,
  similarNavigation,
  onRatePhoto,
  onToggleExportQueue,
  onSelectPhoto,
  onPreviewOpenChange,
  onToggleSimilarRemove,
  onSaveScoreOverride,
  onSaveOrientationOverride
}: InspectorPanelProps) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [scoreDraft, setScoreDraft] = useState("");
  const [isSavingScore, setIsSavingScore] = useState(false);
  const [isSavingOrientation, setIsSavingOrientation] = useState(false);
  const lastPreviewSignalRef = useRef(openPreviewSignal);

  useEffect(() => {
    if (activePhoto && openPreviewSignal > lastPreviewSignalRef.current) {
      setIsPreviewOpen(true);
    }
    lastPreviewSignalRef.current = openPreviewSignal;
  }, [activePhoto, openPreviewSignal]);

  useEffect(() => {
    onPreviewOpenChange?.(isPreviewOpen);
  }, [isPreviewOpen, onPreviewOpenChange]);

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
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isPreviewOpen]);

  const lightboxShortcutHandlers = useMemo<ShortcutHandlers>(() => ({
    "lightbox.close": () => {
      setIsPreviewOpen(false);
    },
    "lightbox.togglePreview": () => {
      setIsPreviewOpen(false);
    },
    "lightbox.previous": () => {
      if (!similarNavigation?.previousId) {
        return false;
      }
      onSelectPhoto(similarNavigation.previousId);
    },
    "lightbox.next": () => {
      if (!similarNavigation?.nextId) {
        return false;
      }
      onSelectPhoto(similarNavigation.nextId);
    }
  }), [onSelectPhoto, similarNavigation]);
  const lightboxShortcutScopes = useMemo(() => ["lightbox" as const], []);

  useShortcuts({
    shortcuts: shortcutRegistry,
    handlers: lightboxShortcutHandlers,
    activeScopes: lightboxShortcutScopes,
    disabled: !isPreviewOpen || shortcutsDisabled
  });

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
      <div className="inspector">
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
            <div className="inspect-title">
              <h3 title={activePhoto.name}>{activePhoto.name}</h3>
              <p>Folder: {activePhoto.folder || "Root"}</p>
            </div>
            <dl className="inspect-list">
              <div className="inspect-row">
                <dt>Rating</dt>
                <dd>
                  <StarRating
                    photo={activePhoto}
                    rating={ratings.get(activePhoto.id) ?? activePhoto.rating ?? 0}
                    onRatePhoto={onRatePhoto}
                  />
                </dd>
              </div>
              <div className="inspect-row">
                <dt>Export</dt>
                <dd>
                  <Button
                    className={`inspector-queue-button ${exportQueueIds.has(activePhoto.id) ? "queued" : ""}`.trim()}
                    variant={exportQueueIds.has(activePhoto.id) ? "secondary" : "outline"}
                    size="sm"
                    aria-pressed={exportQueueIds.has(activePhoto.id)}
                    onClick={() => onToggleExportQueue(activePhoto.id)}
                  >
                    {exportQueueIds.has(activePhoto.id) ? "In Queue" : "Add Queue"}
                  </Button>
                </dd>
              </div>
              <div className="inspect-row"><dt>AI Score</dt><dd className="num inspect-strong">{activePhoto.aiScore}</dd></div>
              <div className="inspect-row"><dt>Raw Score</dt><dd className="num">{activePhoto.score ?? "-"}</dd></div>
              {activePhoto.status !== "done" && (
                <div className={`inspect-row ${activePhoto.status === "error" ? "error" : ""}`.trim()}>
                  <dt>Status</dt>
                  <dd>
                    {activePhoto.status === "pending" && "Waiting in backend queue."}
                    {activePhoto.status === "processing" && "Scoring in backend worker."}
                    {activePhoto.status === "error" && (activePhoto.error || "Scoring failed.")}
                  </dd>
                </div>
              )}
            </dl>
            <ScoreReasonPanel photo={activePhoto} />
            <section className="inspect-section">
              <div className="inspect-section-head">
                <span className="panel-kicker">Manual Override</span>
                <span className="inspect-section-note">
                  {activePhoto.manualScore !== null ? `Using ${activePhoto.manualScore}` : "Using auto score"}
                </span>
              </div>
              <div className="inspect-override">
                <input
                  className="ui-input score-override-input"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={scoreDraft}
                  onChange={(event) => setScoreDraft(event.target.value)}
                  placeholder="0-100"
                  aria-label="Manual score"
                />
                <Button variant="outline" size="sm" onClick={() => void handleSaveScoreOverride()} disabled={isSavingScore}>
                  {isSavingScore ? "Saving..." : "Save"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleResetScoreOverride()}
                  disabled={isSavingScore || activePhoto.manualScore === null}
                >
                  Reset
                </Button>
              </div>
            </section>
            <section className="inspect-section">
              <div className="inspect-section-head">
                <span className="panel-kicker">Orientation</span>
                <span className="inspect-section-note">
                  {activePhoto.orientationOverride ? `${activePhoto.orientationOverride} deg clockwise` : "Using EXIF orientation"}
                </span>
              </div>
              <div className="tab-head inspect-orientation" aria-label="Orientation override">
                {[0, 90, 180, 270].map((degrees) => {
                  const value = degrees as 0 | 90 | 180 | 270;
                  const isActive = (activePhoto.orientationOverride ?? 0) === value;
                  return (
                    <button
                      key={degrees}
                      type="button"
                      className={`tab-btn ${isActive ? "active" : ""}`.trim()}
                      aria-pressed={isActive}
                      onClick={() => void handleOrientationChange(value === 0 ? null : value)}
                      disabled={isSavingOrientation}
                    >
                      {degrees}°
                    </button>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </div>

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

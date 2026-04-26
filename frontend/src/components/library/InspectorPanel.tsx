import { useEffect, useState } from "react";
import type { Photo } from "../../types";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface InspectorPanelProps {
  activePhoto: Photo | null;
  ratings: Map<string, number>;
  onRatePhoto: (id: string, rating: number) => void;
  onSaveScoreOverride: (id: string, manualScore: number | null) => Promise<void>;
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
  return (
    <div className="star-rating" aria-label={`Rating ${rating || "unrated"} out of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          className={`star-btn ${rating >= star ? "filled" : ""}`.trim()}
          onClick={() => onRatePhoto(photo.id, star)}
          aria-label={`Set ${star} star${star === 1 ? "" : "s"}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export function InspectorPanel({
  activePhoto,
  ratings,
  onRatePhoto,
  onSaveScoreOverride
}: InspectorPanelProps) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [scoreDraft, setScoreDraft] = useState("");
  const [isSavingScore, setIsSavingScore] = useState(false);

  useEffect(() => {
    setIsPreviewOpen(false);
  }, [activePhoto?.id]);

  useEffect(() => {
    if (!activePhoto) {
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
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isPreviewOpen]);

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
                <div className="metric-grid">
                  <div className="metric"><span>AI Score</span><strong>{activePhoto.aiScore}</strong></div>
                  <div className="metric"><span>Raw Score</span><strong>{activePhoto.score ?? "-"}</strong></div>
                </div>
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
                <div className="tab-body">
                  <div>Strong score profile based on image quality ranking.</div>
                  <div>This frame is {activePhoto.aiScore >= 70 ? "above" : "below"} your current keep threshold.</div>
                  <div>Rate from 1 to 5 stars, then filter by rating in the library pane.</div>
                </div>
                <div className="inspector-actions">
                  <StarRating
                    photo={activePhoto}
                    rating={ratings.get(activePhoto.id) ?? activePhoto.rating ?? 0}
                    onRatePhoto={onRatePhoto}
                  />
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
          </div>
        </div>
      ) : null}
    </>
  );
}

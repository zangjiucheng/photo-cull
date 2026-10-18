import type { Photo, ViewMode } from "../../types";
import { useState } from "react";

interface PhotoGridProps {
  photos: Photo[];
  ratings: Map<string, number>;
  activePhotoId: string | null;
  viewMode: ViewMode;
  exportQueueIds: Set<string>;
  onSelectPhoto: (id: string) => void;
  onRatePhoto: (id: string, rating: number) => void;
  onToggleExportQueue: (id: string) => void;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function scoreTone(score: number): string {
  if (score >= 82) return "high";
  if (score >= 70) return "mid";
  return "low";
}

function scoreLabel(photo: Photo): string {
  if (photo.status === "pending") return "Pending";
  if (photo.status === "processing") return "Scoring";
  if (photo.status === "error") return "Error";
  return `Score ${photo.aiScore}`;
}

export function PhotoGrid({
  photos,
  ratings,
  activePhotoId,
  viewMode,
  exportQueueIds,
  onSelectPhoto,
  onRatePhoto,
  onToggleExportQueue
}: PhotoGridProps) {
  const [hoverRating, setHoverRating] = useState<{ photoId: string; rating: number } | null>(null);

  return (
    <div className={`gallery bridge-gallery ${viewMode === "list" ? "list-mode" : ""}`}>
      {!photos.length && <div className="empty-gallery">No photos match the current folder and filters.</div>}
      {photos.map((photo) => {
        const rating = ratings.get(photo.id) ?? photo.rating ?? 0;
        const previewRating = hoverRating?.photoId === photo.id ? hoverRating.rating : rating;
        const isActive = activePhotoId === photo.id;
        const isQueued = exportQueueIds.has(photo.id);
        return (
          <article
            key={photo.id}
            className={`photo-card ${isActive ? "active" : ""} ${isQueued ? "queued" : ""}`.trim()}
            data-photo-id={photo.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelectPhoto(photo.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectPhoto(photo.id);
              }
            }}
          >
            <div className="thumb">
              <img src={photo.url} alt={photo.name} loading="lazy" />
              {photo.status !== "done" && (
                <span className={`thumb-status ${photo.status}`}>{scoreLabel(photo)}</span>
              )}
              <button
                type="button"
                className={`queue-button ${isQueued ? "queued" : ""}`.trim()}
                aria-pressed={isQueued}
                title={isQueued ? "Remove from export queue" : "Add to export queue"}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleExportQueue(photo.id);
                }}
              >
                {isQueued ? "In Queue" : "Add Queue"}
              </button>
            </div>
            <div className="meta">
              <div className="meta-row meta-title">
                <span className="name" title={photo.name}>{photo.name}</span>
                {photo.status === "done" && (
                  <span className={`score ${scoreTone(photo.aiScore)}`} title={scoreLabel(photo)}>{photo.aiScore}</span>
                )}
              </div>
              <div className="meta-row">
                <div className="star-rating star-rating-compact" onMouseLeave={() => setHoverRating(null)}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      className={`star-btn ${previewRating >= star ? "filled" : ""}`.trim()}
                      onMouseEnter={() => setHoverRating({ photoId: photo.id, rating: star })}
                      onFocus={() => setHoverRating({ photoId: photo.id, rating: star })}
                      onBlur={() => setHoverRating(null)}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRatePhoto(photo.id, star);
                      }}
                      aria-label={`Set ${star} star${star === 1 ? "" : "s"} for ${photo.name}`}
                    >
                      ★
                    </button>
                  ))}
                </div>
                {isQueued && <span className="queued-flag">Queued</span>}
              </div>
              <div className="file-extra">
                <span>{formatBytes(photo.size)}</span>
                <span>{new Date(photo.mtime * 1000).toLocaleString()}</span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

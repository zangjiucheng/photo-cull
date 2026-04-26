import type { Photo, ViewMode } from "../../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

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
  if (photo.status === "pending") return "Queued";
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
  return (
    <div className={`gallery bridge-gallery ${viewMode === "list" ? "list-mode" : ""}`}>
      {!photos.length && <div className="empty-gallery">No photos match the current folder and filters.</div>}
      {photos.map((photo) => {
        const rating = ratings.get(photo.id) ?? photo.rating ?? 0;
        const isActive = activePhotoId === photo.id;
        const isQueued = exportQueueIds.has(photo.id);
        return (
          <article
            key={photo.id}
            className={`photo-card ${isActive ? "active" : ""}`.trim()}
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
            </div>
            <div className="meta">
              <div className="badges">
                {rating > 0 && <Badge variant="success">{rating} ★</Badge>}
                {isQueued && <Badge variant="secondary">Queued</Badge>}
                <Badge variant={photo.status === "error" ? "danger" : "outline"} className={photo.status === "done" ? scoreTone(photo.aiScore) : ""}>
                  {scoreLabel(photo)}
                </Badge>
              </div>
              <div className="name" title={photo.name}>{photo.name}</div>
              <div className="meta-row">
                <div className="star-rating star-rating-compact">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      className={`star-btn ${rating >= star ? "filled" : ""}`.trim()}
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
              </div>
              <div className="file-extra">
                <span>{formatBytes(photo.size)}</span>
                <span>{new Date(photo.mtime * 1000).toLocaleString()}</span>
              </div>
              <Button
                variant={isQueued ? "secondary" : "outline"}
                size="sm"
                className="queue-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleExportQueue(photo.id);
                }}
              >
                {isQueued ? "In Queue" : "Add Queue"}
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

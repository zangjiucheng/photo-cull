import type { Photo } from "../../types";
import { Button } from "../ui/button";
import { PhotoGrid } from "../library/PhotoGrid";

interface ReviewWorkspaceProps {
  activePhoto: Photo | null;
  folderPhotos: Photo[];
  ratings: Map<string, number>;
  exportQueueIds: Set<string>;
  onSelectPhoto: (id: string) => void;
  onRatePhoto: (id: string, rating: number) => void;
  onAutoRateByScore: () => void;
  onToggleExportQueue: (id: string) => void;
}

export function ReviewWorkspace({ activePhoto, folderPhotos, ratings, exportQueueIds, onSelectPhoto, onRatePhoto, onAutoRateByScore, onToggleExportQueue }: ReviewWorkspaceProps) {
  const rating = activePhoto ? ratings.get(activePhoto.id) ?? activePhoto.rating ?? 0 : 0;
  return (
    <div className="workspace-panel review-workspace">
      <div className="workspace-head">
        <div>
          <span className="panel-kicker">Review</span>
          <h2>{activePhoto ? activePhoto.name : "No Photo Selected"}</h2>
        </div>
        <Button variant="outline" onClick={onAutoRateByScore}>AI Rate Folder</Button>
      </div>
      <div className="review-stage">
        {activePhoto ? (
          <>
            <div className="review-preview"><img src={activePhoto.url} alt={activePhoto.name} /></div>
            <div className="review-controls">
              <div className="star-rating review-stars" aria-label={`Rating ${rating || "unrated"} out of 5`}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <button key={star} type="button" className={`star-btn ${rating >= star ? "filled" : ""}`.trim()} onClick={() => onRatePhoto(activePhoto.id, star)}>★</button>
                ))}
              </div>
              <Button variant={exportQueueIds.has(activePhoto.id) ? "secondary" : "outline"} onClick={() => onToggleExportQueue(activePhoto.id)}>
                {exportQueueIds.has(activePhoto.id) ? "Queued for Export" : "Add to Export Queue"}
              </Button>
            </div>
          </>
        ) : <div className="empty-gallery">Select a photo to begin review.</div>}
      </div>
      <PhotoGrid
        photos={folderPhotos}
        ratings={ratings}
        activePhotoId={activePhoto?.id ?? null}
        viewMode="grid"
        exportQueueIds={exportQueueIds}
        onSelectPhoto={onSelectPhoto}
        onRatePhoto={onRatePhoto}
        onToggleExportQueue={onToggleExportQueue}
      />
    </div>
  );
}

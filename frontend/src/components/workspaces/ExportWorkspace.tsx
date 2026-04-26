import type { Photo } from "../../types";
import { Button } from "../ui/button";

interface ExportWorkspaceProps {
  photos: Photo[];
  queuedIds: string[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onExport: () => void;
  onSelectPhoto: (id: string) => void;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function ExportWorkspace({ photos, queuedIds, onRemove, onClear, onExport, onSelectPhoto }: ExportWorkspaceProps) {
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const queuedPhotos = queuedIds.map((id) => byId.get(id)).filter((photo): photo is Photo => Boolean(photo));
  const totalBytes = queuedPhotos.reduce((sum, photo) => sum + photo.size, 0);

  return (
    <div className="workspace-panel">
      <div className="workspace-head">
        <div>
          <span className="panel-kicker">Export</span>
          <h2>{queuedPhotos.length} queued photo(s)</h2>
          <p>{formatBytes(totalBytes)} selected for ZIP export.</p>
        </div>
        <div className="workspace-actions">
          <Button variant="outline" onClick={onClear} disabled={!queuedPhotos.length}>Clear</Button>
          <Button variant="default" onClick={onExport} disabled={!queuedPhotos.length}>Export ZIP</Button>
        </div>
      </div>
      <div className="export-list">
        {queuedPhotos.map((photo) => (
          <article className="export-row" key={photo.id}>
            <button className="export-thumb" onClick={() => onSelectPhoto(photo.id)}><img src={photo.url} alt={photo.name} loading="lazy" /></button>
            <div>
              <strong>{photo.name}</strong>
              <span>{photo.folder || "Root"} · Score {photo.aiScore} · {formatBytes(photo.size)}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onRemove(photo.id)}>Remove</Button>
          </article>
        ))}
        {!queuedPhotos.length ? <div className="empty-gallery">Add photos from Browse, Review, or Duplicates before exporting.</div> : null}
      </div>
    </div>
  );
}

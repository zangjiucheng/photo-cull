import type { SimilarGroup } from "../../types";
import { Button } from "../ui/button";

interface DuplicatesWorkspaceProps {
  similarGroups: SimilarGroup[];
  similarDeleteIds: Set<string>;
  exportQueueIds: Set<string>;
  activePhotoId: string | null;
  isFindingSimilar: boolean;
  isDeletingSimilar: boolean;
  similarityProgress: {
    percent: number;
    label: string;
    detail: string;
  } | null;
  activeFolderPath: string;
  onFindSimilar: () => void;
  onSelectPhoto: (id: string) => void;
  onToggleSimilarDelete: (id: string) => void;
  onDeleteSimilarSelected: () => void;
  onAddToExportQueue: (id: string) => void;
}

function formatSize(size: number): string {
  return `${Math.round(size / 1024)} KB`;
}

export function DuplicatesWorkspace({
  similarGroups,
  similarDeleteIds,
  exportQueueIds,
  activePhotoId,
  isFindingSimilar,
  isDeletingSimilar,
  similarityProgress,
  activeFolderPath,
  onFindSimilar,
  onSelectPhoto,
  onToggleSimilarDelete,
  onDeleteSimilarSelected,
  onAddToExportQueue
}: DuplicatesWorkspaceProps) {
  return (
    <div className="workspace-panel duplicates-workspace">
      {isFindingSimilar ? (
        <div className="workspace-loading-overlay" role="status" aria-live="polite" aria-label="Loading similar photos">
          <div className="app-loading-panel workspace-loading-panel">
            <span className="app-loading-spinner" aria-hidden="true" />
            <strong>{similarityProgress?.label ?? "Finding similar photos"}</strong>
            <span>{similarityProgress?.detail ?? "Preparing similarity scan"}</span>
          </div>
        </div>
      ) : null}
      <div className="dup-head">
        <div className="dup-head-text">
          <h2 title={activeFolderPath || "All Photos"}>{activeFolderPath || "All Photos"}</h2>
          <p>Review visually similar photos with pHash first, then CLIP + FAISS when available. Scope defaults to the current folder.</p>
        </div>
        <div className="workspace-actions dup-actions">
          <Button variant="outline" size="sm" onClick={onFindSimilar} disabled={isFindingSimilar}>{isFindingSimilar ? "Finding..." : "Find Similar"}</Button>
          <Button variant="destructive" size="sm" onClick={onDeleteSimilarSelected} disabled={isDeletingSimilar || similarDeleteIds.size === 0}>
            {isDeletingSimilar ? "Deleting..." : `Delete ${similarDeleteIds.size}`}
          </Button>
        </div>
      </div>
      {similarityProgress ? (
        <div className={`duplicate-progress ${isFindingSimilar ? "active" : ""}`.trim()}>
          <div className="duplicate-progress-head">
            <strong>{similarityProgress.label}</strong>
            <p>{similarityProgress.detail}</p>
            <span>{similarityProgress.percent}%</span>
          </div>
          <div className="duplicate-progress-bar" aria-label="Similarity scan progress">
            <span style={{ width: `${similarityProgress.percent}%` }} />
          </div>
        </div>
      ) : null}
      {similarGroups.length ? (
        <div className="similar-groups duplicate-groups">
          {similarGroups.map((group, groupIndex) => (
            <section className="similar-group" key={group.id}>
              <div className="similar-group-title">
                <strong>Group {groupIndex + 1}</strong>
                <span>{group.photos.length} photos</span>
                <span>{group.stage} · {group.tier}{group.maxSimilarity ? ` · CLIP ${group.maxSimilarity}` : ""}</span>
              </div>
              <div className="similar-strip">
                {group.photos.map((photo) => {
                  const isChecked = similarDeleteIds.has(photo.id);
                  const isQueued = exportQueueIds.has(photo.id);
                  const candidate = group.candidates.find((item) => item.photoId === photo.id);
                  const resolution = candidate ? `${candidate.metadata.width}x${candidate.metadata.height}` : "";
                  const isKeep = group.keepPhotoId === photo.id;
                  return (
                    <article
                      key={photo.id}
                      className={`similar-thumb ${isKeep ? "keep" : ""} ${isChecked ? "marked" : ""} ${activePhotoId === photo.id ? "active" : ""}`.replace(/\s+/g, " ").trim()}
                      data-photo-id={photo.id}
                    >
                      <button className="similar-preview" type="button" onClick={() => onSelectPhoto(photo.id)}>
                        <img src={photo.url} alt={photo.name} loading="lazy" />
                        <span className="similar-rank">{isKeep ? "Keep" : "Candidate"}</span>
                      </button>
                      <span className="similar-name" title={photo.name}>{photo.name}</span>
                      <span className="similar-score">Score {photo.aiScore} · {resolution}</span>
                      {candidate ? <span className="similar-score">{formatSize(candidate.metadata.fileSize)}{candidate.metadata.hasGps ? " · GPS" : ""}{candidate.metadata.takenAt ? ` · ${candidate.metadata.takenAt}` : ""}</span> : null}
                      <div className="similar-actions">
                        <label className="similar-delete">
                          <input type="checkbox" checked={isChecked} disabled={isKeep} onChange={() => onToggleSimilarDelete(photo.id)} />
                          Delete
                        </label>
                        <button
                          className={`queue-link ${isQueued ? "queued" : ""}`.trim()}
                          type="button"
                          onClick={() => onAddToExportQueue(photo.id)}
                          disabled={isQueued}
                        >
                          {isQueued ? "Queued" : "Queue"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : <div className="similar-empty">No similar photo groups for this folder yet.</div>}
    </div>
  );
}

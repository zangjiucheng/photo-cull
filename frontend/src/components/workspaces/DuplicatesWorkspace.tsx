import type { SimilarGroup } from "../../types";
import { Button } from "../ui/button";

interface DuplicatesWorkspaceProps {
  similarGroups: SimilarGroup[];
  similarDeleteIds: Set<string>;
  isFindingSimilar: boolean;
  isDeletingSimilar: boolean;
  similarSummary: string;
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
  isFindingSimilar,
  isDeletingSimilar,
  similarSummary,
  activeFolderPath,
  onFindSimilar,
  onSelectPhoto,
  onToggleSimilarDelete,
  onDeleteSimilarSelected,
  onAddToExportQueue
}: DuplicatesWorkspaceProps) {
  return (
    <div className="workspace-panel">
      <div className="workspace-head">
        <div>
          <span className="panel-kicker">Duplicates</span>
          <h2>{activeFolderPath || "All Photos"}</h2>
          <p>Runs pHash first, then CLIP + FAISS when available. Scope defaults to the current folder.</p>
        </div>
        <div className="workspace-actions">
          <Button variant="outline" onClick={onFindSimilar} disabled={isFindingSimilar}>{isFindingSimilar ? "Finding..." : "Find Similar"}</Button>
          <Button variant="destructive" onClick={onDeleteSimilarSelected} disabled={isDeletingSimilar || similarDeleteIds.size === 0}>
            {isDeletingSimilar ? "Deleting..." : `Delete ${similarDeleteIds.size}`}
          </Button>
        </div>
      </div>
      {similarSummary ? <div className="similar-summary bridge-summary">{similarSummary}</div> : null}
      {similarGroups.length ? (
        <div className="similar-groups duplicate-groups">
          {similarGroups.map((group, groupIndex) => (
            <article className="similar-group" key={group.id}>
              <div className="similar-group-title">
                <strong>Group {groupIndex + 1}</strong>
                <span>{group.photos.length} photos</span>
                <span>{group.stage} · {group.tier}{group.maxSimilarity ? ` · CLIP ${group.maxSimilarity}` : ""}</span>
              </div>
              <div className="similar-strip">
                {group.photos.map((photo) => {
                  const isChecked = similarDeleteIds.has(photo.id);
                  const candidate = group.candidates.find((item) => item.photoId === photo.id);
                  const resolution = candidate ? `${candidate.metadata.width}x${candidate.metadata.height}` : "";
                  const isKeep = group.keepPhotoId === photo.id;
                  return (
                    <article key={photo.id} className={`similar-thumb ${isChecked ? "marked" : ""}`.trim()}>
                      <button className="similar-preview" type="button" onClick={() => onSelectPhoto(photo.id)}>
                        <img src={photo.url} alt={photo.name} loading="lazy" />
                      </button>
                      <span className="similar-rank">{isKeep ? "Keep" : "Candidate"}</span>
                      <label className="similar-delete">
                        <input type="checkbox" checked={isChecked} disabled={isKeep} onChange={() => onToggleSimilarDelete(photo.id)} />
                        Delete
                      </label>
                      <button className="link-button queue-link" onClick={() => onAddToExportQueue(photo.id)}>Queue</button>
                      <span className="similar-name" title={photo.name}>{photo.name}</span>
                      <span className="similar-score">Score {photo.aiScore} · {resolution}</span>
                      {candidate ? <span className="similar-score">{formatSize(candidate.metadata.fileSize)}{candidate.metadata.hasGps ? " · GPS" : ""}{candidate.metadata.takenAt ? ` · ${candidate.metadata.takenAt}` : ""}</span> : null}
                    </article>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      ) : <div className="similar-empty">No duplicate groups for this folder yet.</div>}
    </div>
  );
}

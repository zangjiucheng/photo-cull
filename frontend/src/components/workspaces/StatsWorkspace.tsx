import type { CSSProperties } from "react";
import type { LibraryFolder } from "../../types";

interface StatsWorkspaceProps {
  activeFolder: LibraryFolder | null;
  totalPhotos: number;
  visibleCount: number;
  folderPhotosCount: number;
  ratedCount: number;
  exportQueueCount: number;
  fourPlusCount: number;
  processingInFlight: number;
  completedCount: number;
  processingTotal: number;
  keepRate: number;
  reviewRate: number;
  processingProgress: number;
}

export function StatsWorkspace({
  activeFolder,
  totalPhotos,
  visibleCount,
  folderPhotosCount,
  ratedCount,
  exportQueueCount,
  fourPlusCount,
  processingInFlight,
  completedCount,
  processingTotal,
  keepRate,
  reviewRate,
  processingProgress
}: StatsWorkspaceProps) {
  return (
    <div className="workspace-panel stats-workspace">
      <div className="workspace-head">
        <div>
          <span className="panel-kicker">Stats</span>
          <h2>{activeFolder?.path || "All Photos"}</h2>
        </div>
      </div>
      <section className="stats-hero inline-stats-hero">
        <div className="stats-hero-copy">
          <span className="stats-eyebrow">Rating coverage</span>
          <div className="stats-hero-value"><strong>{reviewRate}%</strong><span>{ratedCount}/{totalPhotos || 0} frames rated</span></div>
          <p>{fourPlusCount} photos are 4+ stars. {exportQueueCount} photos are in the explicit export queue.</p>
        </div>
        <div className="stats-ring" style={{ "--ring-value": reviewRate * 3.6 } as CSSProperties} aria-hidden="true">
          <div className="stats-ring-inner"><span>Rated</span><strong>{reviewRate}%</strong></div>
        </div>
      </section>
      <div className="stats-grid">
        <article className="mini-stat mini-stat-accent"><span>Visible</span><strong>{visibleCount}</strong><small>after filters</small></article>
        <article className="mini-stat"><span>Folder</span><strong>{folderPhotosCount}</strong><small>current scope</small></article>
        <article className="mini-stat"><span>Export Queue</span><strong>{exportQueueCount}</strong><small>explicit picks</small></article>
        <article className="mini-stat"><span>In Queue</span><strong>{processingInFlight}</strong><small>still scoring</small></article>
      </div>
      <section className="stats-panel">
        <div className="stats-progress-group">
          <div className="progress-head"><span>Filter retention</span><span>{keepRate}%</span></div>
          <div className="progress progress-retention"><span style={{ width: `${keepRate}%` }} /></div>
        </div>
        <div className="stats-progress-group">
          <div className="progress-head"><span>Background scoring</span><span>{processingProgress}%</span></div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={processingProgress}>
            <span style={{ width: `${processingProgress}%` }} />
          </div>
        </div>
        <div className="progress-meta"><span>{completedCount}/{processingTotal} completed</span><span>{processingInFlight} in queue</span></div>
      </section>
    </div>
  );
}

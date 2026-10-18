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

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value || 0));
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
  const figures: Array<{ label: string; value: number | string; note: string }> = [
    { label: "Visible", value: visibleCount, note: "after filters" },
    { label: "Folder", value: folderPhotosCount, note: "current scope" },
    { label: "Export Queue", value: exportQueueCount, note: "explicit picks" },
    { label: "4+ Stars", value: fourPlusCount, note: "top rated" },
    { label: "In Queue", value: processingInFlight, note: "still scoring" }
  ];

  const bars: Array<{ label: string; value: number; detail: string; progressbar?: boolean }> = [
    { label: "Filter retention", value: keepRate, detail: `${visibleCount} of ${folderPhotosCount} visible` },
    {
      label: "Background scoring",
      value: processingProgress,
      detail: `${completedCount}/${processingTotal} completed · ${processingInFlight} in queue`,
      progressbar: true
    }
  ];

  return (
    <div className="workspace-panel stats-workspace">
      <header className="stats-head">
        <h2 title={activeFolder?.path || "All Photos"}>{activeFolder?.path || "All Photos"}</h2>
      </header>

      <section className="stats-lead" aria-label="Rating coverage">
        <strong className="stats-lead-value">{reviewRate}%</strong>
        <div className="stats-lead-copy">
          <span>{ratedCount}/{totalPhotos || 0} frames rated</span>
          <span>{fourPlusCount} photos are 4+ stars. {exportQueueCount} photos are in the explicit export queue.</span>
        </div>
      </section>

      <dl className="stats-figures">
        {figures.map((figure) => (
          <div key={figure.label} className="stats-figure">
            <dt>{figure.label}</dt>
            <dd>{figure.value}</dd>
            <small>{figure.note}</small>
          </div>
        ))}
      </dl>

      <section className="stats-bars">
        {bars.map((bar) => {
          const percent = clampPercent(bar.value);
          return (
            <div key={bar.label} className="stats-bar">
              <div className="stats-bar-head">
                <span>{bar.label}</span>
                <span className="stats-bar-value">{bar.value}%</span>
              </div>
              <div
                className="stats-bar-track"
                {...(bar.progressbar
                  ? { role: "progressbar", "aria-label": bar.label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": bar.value }
                  : { "aria-hidden": true })}
              >
                <span style={{ width: `${percent}%` }} />
              </div>
              <small>{bar.detail}</small>
            </div>
          );
        })}
      </section>
    </div>
  );
}

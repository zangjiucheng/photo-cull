import type { CSSProperties, ReactNode } from "react";
import type { WorkspaceTab } from "../../types";
import { Button } from "../ui/button";

const tabs: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "browse", label: "Browse" },
  { id: "review", label: "Review" },
  { id: "duplicates", label: "Duplicates" },
  { id: "export", label: "Export" },
  { id: "stats", label: "Stats" }
];

interface WorkspaceShellProps {
  activeTab: WorkspaceTab;
  currentPath: string;
  exportQueueCount: number;
  isRefreshing: boolean;
  isRescoring?: boolean;
  scoringProgress?: {
    completed: number;
    pending: number;
    processing: number;
    total: number;
    percent: number;
  };
  sidebar: ReactNode;
  children: ReactNode;
  inspector: ReactNode;
  onTabChange: (tab: WorkspaceTab) => void;
  onRefresh: () => void;
  onRefreshScores?: () => void;
  onExportQueue: () => void;
}

export function WorkspaceShell({
  activeTab,
  currentPath,
  exportQueueCount,
  isRefreshing,
  isRescoring = false,
  scoringProgress,
  sidebar,
  children,
  inspector,
  onTabChange,
  onRefresh,
  onRefreshScores,
  onExportQueue
}: WorkspaceShellProps) {
  const isScoring = Boolean(scoringProgress && (scoringProgress.processing > 0 || scoringProgress.pending > 0));
  const progressDegrees = scoringProgress ? Math.round((scoringProgress.percent / 100) * 360) : 0;
  const scoringState = isScoring ? "active" : "idle";

  return (
    <div className="bridge-shell">
      <header className="bridge-topbar">
        <div className="brand-lockup">
          <strong>AI Photo Culling</strong>
          <span>{currentPath || "All Photos"}</span>
        </div>
        <nav className="workspace-tabs" aria-label="Workspace tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`workspace-tab ${activeTab === tab.id ? "active" : ""}`.trim()}
              onClick={() => onTabChange(tab.id)}
              aria-current={activeTab === tab.id ? "page" : undefined}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="bridge-actions">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing}>{isRefreshing ? "Refreshing" : "Refresh"}</Button>
          <Button variant="default" size="sm" onClick={onExportQueue}>Export Queue ({exportQueueCount})</Button>
          {scoringProgress ? (
            <div
              className={`scoring-progress ${scoringState}`}
              style={{ "--progress-deg": `${progressDegrees}deg` } as CSSProperties}
              aria-label={isScoring ? `Background scoring ${scoringProgress.percent}% complete` : "Background scoring idle"}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={scoringProgress.percent}
              tabIndex={0}
            >
              <span className="scoring-progress-ring">
                <span>{scoringProgress.percent}</span>
              </span>
              <div className="scoring-progress-popover" role="tooltip">
                <strong>Background scoring</strong>
                <span>{isScoring ? "Scoring in background" : "Idle"}</span>
                <span>{scoringProgress.completed} of {scoringProgress.total} complete</span>
                <span>{scoringProgress.processing} processing</span>
                <span>{scoringProgress.pending} queued</span>
                {onRefreshScores ? (
                  <button
                    className="scoring-progress-action"
                    type="button"
                    onClick={onRefreshScores}
                    disabled={isRescoring || scoringProgress.total === 0}
                  >
                    {isRescoring ? "Queueing..." : "Refresh AI Scores"}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </header>
      <main className="bridge-layout">
        <aside className="bridge-sidebar">{sidebar}</aside>
        <section className="bridge-content">{children}</section>
        <aside className="bridge-inspector">{inspector}</aside>
      </main>
    </div>
  );
}

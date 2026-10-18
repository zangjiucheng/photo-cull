import type { CSSProperties, ReactNode } from "react";
import type { AiRuntimeStatus, WorkspaceTab } from "../../types";
import { modLabel } from "../../lib/platform";
import { Button } from "../ui/button";

const tabs: Array<{ id: WorkspaceTab; label: string; shortcut: string; detail: string }> = [
  { id: "browse", label: "Browse", shortcut: `${modLabel}+1`, detail: "Browse and filter the active photo library." },
  { id: "review", label: "Review", shortcut: `${modLabel}+2`, detail: "Review photos, rate picks, and manage queue decisions." },
  { id: "duplicates", label: "Similarity", shortcut: `${modLabel}+3`, detail: "Find visually similar groups and choose what to keep." },
  { id: "export-enhance", label: "Enhance & Export", shortcut: `${modLabel}+4`, detail: "Apply styles, AI restoration, and export selected photos." },
  { id: "stats", label: "Stats", shortcut: `${modLabel}+5`, detail: "Check library progress, ratings, and export queue counts." },
  { id: "settings", label: "Settings", shortcut: `${modLabel}+6`, detail: "AI Runtime, its Python, and install logs." }
];

interface WorkspaceShellProps {
  activeTab: WorkspaceTab;
  currentPath: string;
  isRefreshing: boolean;
  isRescoring?: boolean;
  backgroundProgress?: {
    title: string;
    state: "active" | "idle" | "error";
    detail: string;
    completed: number;
    pending: number;
    processing: number;
    total: number;
    percent: number;
  };
  aiRuntimeStatus?: AiRuntimeStatus | null;
  sidebar: ReactNode;
  children: ReactNode;
  inspector: ReactNode;
  onTabChange: (tab: WorkspaceTab) => void;
  onRefresh: () => void;
  onRefreshScores?: () => void;
  onInstallAiRuntime?: () => void;
}

export function WorkspaceShell({
  activeTab,
  currentPath,
  isRefreshing,
  isRescoring = false,
  backgroundProgress,
  aiRuntimeStatus,
  sidebar,
  children,
  inspector,
  onTabChange,
  onRefresh,
  onRefreshScores,
  onInstallAiRuntime
}: WorkspaceShellProps) {
  const shellTabClass = `workspace-tab-${activeTab.replace(/[^a-z0-9_-]/gi, "-")}`;
  const hasInspector = Boolean(inspector);
  const isActive = backgroundProgress?.state === "active";
  const progressDegrees = backgroundProgress ? Math.round((backgroundProgress.percent / 100) * 360) : 0;
  const progressState = backgroundProgress?.state ?? "idle";
  const aiRuntimeButtonLabel = aiRuntimeStatus?.installing
    ? "Installing AI..."
    : aiRuntimeStatus?.installed
      ? aiRuntimeStatus.using ? "AI Runtime Active" : "AI Runtime Installed"
      : "Install AI Runtime";

  return (
    <div className={`bridge-shell ${shellTabClass} ${hasInspector ? "" : "without-inspector"}`.trim()}>
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
              aria-describedby={`workspace-tab-tip-${tab.id}`}
            >
              <span>{tab.label}</span>
              <span className="workspace-tab-tooltip" id={`workspace-tab-tip-${tab.id}`} role="tooltip">
                <strong>{tab.label}</strong>
                <span>{tab.detail}</span>
                <kbd>{tab.shortcut}</kbd>
              </span>
            </button>
          ))}
        </nav>
        <div className="bridge-actions">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing}>{isRefreshing ? "Refreshing" : "Refresh"}</Button>
          {aiRuntimeStatus?.available && onInstallAiRuntime ? (
            <Button
              className={`ai-runtime-topbar-button ${aiRuntimeStatus.state === "error" ? "error" : ""}`.trim()}
              variant={aiRuntimeStatus.installed ? "secondary" : "outline"}
              size="sm"
              onClick={onInstallAiRuntime}
              disabled={aiRuntimeStatus.installing || aiRuntimeStatus.installed}
              title="Open Settings to choose its Python and view install logs"
            >
              {aiRuntimeButtonLabel}
            </Button>
          ) : null}
          {backgroundProgress ? (
            <div
              className={`scoring-progress ${progressState}`}
              style={{ "--progress-deg": `${progressDegrees}deg` } as CSSProperties}
              aria-label={isActive ? `${backgroundProgress.title} ${backgroundProgress.percent}% complete` : `${backgroundProgress.title} idle`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={backgroundProgress.percent}
              tabIndex={0}
            >
              <span className="scoring-progress-ring">
                <span>{backgroundProgress.percent}</span>
              </span>
              <div className="scoring-progress-popover" role="tooltip">
                <strong>{backgroundProgress.title}</strong>
                <span>{backgroundProgress.detail}</span>
                <span>{backgroundProgress.completed} of {backgroundProgress.total} complete</span>
                <span>{backgroundProgress.processing} processing</span>
                <span>{backgroundProgress.pending} queued</span>
                {onRefreshScores ? (
                  <button
                    className="scoring-progress-action"
                    type="button"
                    onClick={onRefreshScores}
                    disabled={isRescoring || backgroundProgress.total === 0}
                  >
                    {isRescoring ? "Queueing..." : "Refresh AI Scores"}
                  </button>
                ) : null}
                {aiRuntimeStatus ? (
                  <span className={`ai-runtime-status ${aiRuntimeStatus.state === "error" ? "error" : ""}`.trim()}>
                    {aiRuntimeStatus.state === "error" ? aiRuntimeStatus.error || aiRuntimeStatus.message : aiRuntimeStatus.detail || aiRuntimeStatus.message}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </header>
      <main className="bridge-layout">
        <aside className="bridge-sidebar">{sidebar}</aside>
        <section className="bridge-content">{children}</section>
        {hasInspector ? <aside className="bridge-inspector">{inspector}</aside> : null}
      </main>
    </div>
  );
}

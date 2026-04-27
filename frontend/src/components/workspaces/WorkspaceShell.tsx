import type { ReactNode } from "react";
import type { PhotoWorkspace, StatusTone, WorkspaceTab } from "../../types";
import { Badge } from "../ui/badge";
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
  statusText: string;
  statusTone: StatusTone;
  currentPath: string;
  workspaces: PhotoWorkspace[];
  activeWorkspaceId: string | null;
  excludedCount: number;
  exportQueueCount: number;
  isRefreshing: boolean;
  sidebar: ReactNode;
  children: ReactNode;
  inspector: ReactNode;
  onTabChange: (tab: WorkspaceTab) => void;
  onOpenFolder: () => void;
  onWorkspaceChange: (workspaceId: string) => void;
  onRefresh: () => void;
  onExportQueue: () => void;
  onRestoreRemoved: () => void;
}

export function WorkspaceShell({
  activeTab,
  statusText,
  statusTone,
  currentPath,
  workspaces,
  activeWorkspaceId,
  excludedCount,
  exportQueueCount,
  isRefreshing,
  sidebar,
  children,
  inspector,
  onTabChange,
  onOpenFolder,
  onWorkspaceChange,
  onRefresh,
  onExportQueue,
  onRestoreRemoved
}: WorkspaceShellProps) {
  return (
    <div className="bridge-shell">
      <header className="bridge-topbar">
        <div className="brand-lockup">
          <strong>AI Photo Culling</strong>
          <span>{currentPath || "All Photos"}</span>
        </div>
        <select
          className="workspace-switcher"
          value={activeWorkspaceId ?? ""}
          onChange={(event) => {
            if (event.target.value) onWorkspaceChange(event.target.value);
          }}
          aria-label="Photo workspace"
        >
          <option value="">No workspace</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
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
          <Button variant="outline" size="sm" onClick={onOpenFolder}>Open Folder</Button>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing}>{isRefreshing ? "Refreshing" : "Refresh"}</Button>
          <Button variant="outline" size="sm" onClick={onRestoreRemoved} disabled={!excludedCount}>Restore Removed ({excludedCount})</Button>
          <Button variant="default" size="sm" onClick={onExportQueue}>Export Queue ({exportQueueCount})</Button>
          <Badge className="toolbar-status" variant={statusTone === "ok" ? "success" : statusTone === "error" ? "danger" : "secondary"}>{statusText}</Badge>
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

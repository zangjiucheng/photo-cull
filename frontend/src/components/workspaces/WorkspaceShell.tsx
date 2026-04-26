import type { ReactNode } from "react";
import type { StatusTone, WorkspaceTab } from "../../types";
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
  exportQueueCount: number;
  isRefreshing: boolean;
  sidebar: ReactNode;
  children: ReactNode;
  inspector: ReactNode;
  onTabChange: (tab: WorkspaceTab) => void;
  onUpload: (files: FileList | null) => void;
  onRefresh: () => void;
  onExportQueue: () => void;
}

export function WorkspaceShell({
  activeTab,
  statusText,
  statusTone,
  currentPath,
  exportQueueCount,
  isRefreshing,
  sidebar,
  children,
  inspector,
  onTabChange,
  onUpload,
  onRefresh,
  onExportQueue
}: WorkspaceShellProps) {
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
          <label className="toolbar-upload" htmlFor="fileInput">Upload</label>
          <input id="fileInput" type="file" multiple accept="image/*" hidden onChange={(e) => onUpload(e.target.files)} />
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing}>{isRefreshing ? "Refreshing" : "Refresh"}</Button>
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

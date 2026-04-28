import type { PhotoWorkspace, StatusTone } from "../../types";
import { Badge } from "../ui/badge";

interface WorkspaceLauncherProps {
  workspaces: PhotoWorkspace[];
  statusText: string;
  statusTone: StatusTone;
  isLoading: boolean;
  onOpenFolder: () => void;
  onOpenWorkspaceFile: () => void;
  onWorkspaceChange: (workspaceId: string) => void;
}

export function WorkspaceLauncher({
  workspaces,
  statusText,
  statusTone,
  isLoading,
  onOpenFolder,
  onOpenWorkspaceFile,
  onWorkspaceChange
}: WorkspaceLauncherProps) {
  return (
    <main className="workspace-launcher vscode-launcher">
      <section className="vscode-welcome">
        <aside className="welcome-start">
          <div className="welcome-brand">
            <span>AI Photo Culling</span>
            <h1>Welcome</h1>
          </div>
          <div className="welcome-section">
            <h2>Start</h2>
            <button className="welcome-action primary" onClick={onOpenFolder}>Open Folder...</button>
            <button className="welcome-action" onClick={onOpenWorkspaceFile}>Open Workspace File...</button>
          </div>
          <div className="welcome-section">
            <h2>Recent</h2>
            {isLoading ? (
              <div className="welcome-muted-row">Loading workspaces...</div>
            ) : workspaces.length ? (
              <div className="welcome-recent-list">
                {workspaces.map((workspace) => (
                  <button className="welcome-recent" key={workspace.id} onClick={() => onWorkspaceChange(workspace.id)}>
                    <strong>{workspace.name}</strong>
                    <span>{workspace.rootPath}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="welcome-muted-row">No recent workspaces</div>
            )}
          </div>
        </aside>
        <section className="welcome-main">
          <div className="welcome-title-row">
            <div>
              <span className="panel-kicker">Workspace</span>
              <h2>Open a photo folder</h2>
            </div>
            <Badge variant={statusTone === "error" ? "danger" : statusTone === "ok" ? "success" : "secondary"}>
              {isLoading ? "Loading" : statusText}
            </Badge>
          </div>
          <div className="welcome-card">
            <strong>Folder workspaces</strong>
            <p>Open a local folder to index photos in place. Ratings, similarity groups, and export queues stay scoped to that workspace.</p>
            <button className="welcome-card-action" onClick={onOpenFolder}>Open Folder</button>
          </div>
        </section>
      </section>
    </main>
  );
}

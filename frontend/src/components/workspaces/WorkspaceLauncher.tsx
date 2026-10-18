import type { PhotoWorkspace, StatusTone } from "../../types";
import { Button } from "../ui/button";

interface WorkspaceLauncherProps {
  workspaces: PhotoWorkspace[];
  statusText: string;
  statusTone: StatusTone;
  isLoading: boolean;
  onOpenFolder: () => void;
  onOpenWorkspaceFile: () => void;
  onWorkspaceChange: (workspaceId: string) => void;
  onWorkspaceDelete: (workspaceId: string) => void;
}

export function WorkspaceLauncher({
  workspaces,
  statusText,
  statusTone,
  isLoading,
  onOpenFolder,
  onOpenWorkspaceFile,
  onWorkspaceChange,
  onWorkspaceDelete
}: WorkspaceLauncherProps) {
  return (
    <main className="launcher">
      {isLoading ? (
        <div className="app-loading-overlay" role="status" aria-live="polite" aria-label="Loading application">
          <div className="app-loading-panel">
            <span className="app-loading-spinner" aria-hidden="true" />
            <strong>Loading</strong>
            <span>Preparing workspaces</span>
          </div>
        </div>
      ) : null}
      <section className="launcher-panel">
        <header className="launcher-brand">
          <h1>AI Photo Culling</h1>
          <span className={`launcher-status ${statusTone}`}>{isLoading ? "Loading" : statusText}</span>
        </header>
        <div className="launcher-actions">
          <Button onClick={onOpenFolder}>Open Folder...</Button>
          <Button variant="outline" onClick={onOpenWorkspaceFile}>Open Workspace File...</Button>
        </div>
        <div className="launcher-recent">
          <span className="panel-kicker">Recent</span>
          {isLoading ? (
            <div className="launcher-empty">Loading workspaces...</div>
          ) : workspaces.length ? (
            <ul>
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <button className="launcher-recent-open" onClick={() => onWorkspaceChange(workspace.id)}>
                    <strong>{workspace.name}</strong>
                    <span>{workspace.rootPath}</span>
                  </button>
                  <button
                    className="launcher-recent-delete"
                    type="button"
                    onClick={() => onWorkspaceDelete(workspace.id)}
                    aria-label={`Delete ${workspace.name} workspace`}
                    title="Delete workspace"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="launcher-empty">No recent workspaces</div>
          )}
        </div>
      </section>
    </main>
  );
}

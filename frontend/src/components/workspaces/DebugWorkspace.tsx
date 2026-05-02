import type { AiRuntimeStatus } from "../../types";
import { Button } from "../ui/button";

interface DebugWorkspaceProps {
  aiRuntimeStatus: AiRuntimeStatus | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onInstallAiRuntime: () => void;
}

export function DebugWorkspace({
  aiRuntimeStatus,
  isRefreshing,
  onRefresh,
  onInstallAiRuntime
}: DebugWorkspaceProps) {
  const runtimeMessage = aiRuntimeStatus
    ? aiRuntimeStatus.state === "error" ? aiRuntimeStatus.error || aiRuntimeStatus.message : aiRuntimeStatus.detail || aiRuntimeStatus.message
    : "AI Runtime status is unavailable.";

  return (
    <div className="workspace-panel debug-workspace">
      <section className="debug-panel">
        <div className="debug-panel-head">
          <div>
            <span className="panel-kicker">Runtime</span>
            <strong>AI Runtime</strong>
          </div>
          <div className="debug-actions">
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing}>
              {isRefreshing ? "Refreshing" : "Refresh"}
            </Button>
            {aiRuntimeStatus?.available ? (
              <Button
                variant={aiRuntimeStatus.installed ? "secondary" : "default"}
                size="sm"
                onClick={onInstallAiRuntime}
                disabled={aiRuntimeStatus.installing || aiRuntimeStatus.installed}
              >
                {aiRuntimeStatus.installing
                  ? "Installing AI..."
                  : aiRuntimeStatus.installed
                    ? aiRuntimeStatus.using ? "AI Runtime Active" : "AI Runtime Installed"
                    : "Install AI Runtime"}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="debug-runtime-grid">
          <div>
            <span>Status</span>
            <strong>{aiRuntimeStatus?.state ?? "unavailable"}</strong>
          </div>
          <div>
            <span>Installed</span>
            <strong>{aiRuntimeStatus?.installed ? "Yes" : "No"}</strong>
          </div>
          <div>
            <span>Using</span>
            <strong>{aiRuntimeStatus?.using ? "Yes" : "No"}</strong>
          </div>
          <div>
            <span>Installing</span>
            <strong>{aiRuntimeStatus?.installing ? "Yes" : "No"}</strong>
          </div>
        </div>

        <div className={`debug-message ${aiRuntimeStatus?.state === "error" ? "error" : ""}`.trim()}>
          {runtimeMessage}
        </div>
      </section>

      <section className="debug-panel">
        <div className="debug-panel-head">
          <div>
            <span className="panel-kicker">Background Log</span>
            <strong>AI Runtime Install Log</strong>
          </div>
        </div>
        <div className="debug-log-path">{aiRuntimeStatus?.logPath || "No log path available."}</div>
        <pre className="debug-log">{aiRuntimeStatus?.logTail?.length ? aiRuntimeStatus.logTail.join("\n") : "No install log yet."}</pre>
      </section>
    </div>
  );
}

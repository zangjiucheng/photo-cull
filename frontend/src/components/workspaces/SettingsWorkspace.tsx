import type { AiRuntimeStatus } from "../../types";
import { Button } from "../ui/button";
import { PythonSettings } from "./PythonSettings";
import { UpdateSettings } from "./UpdateSettings";

interface SettingsWorkspaceProps {
  aiRuntimeStatus: AiRuntimeStatus | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onInstallAiRuntime: () => void;
}

export function SettingsWorkspace({
  aiRuntimeStatus,
  isRefreshing,
  onRefresh,
  onInstallAiRuntime
}: SettingsWorkspaceProps) {
  const isError = aiRuntimeStatus?.state === "error";
  const runtimeMessage = aiRuntimeStatus
    ? isError ? aiRuntimeStatus.error || aiRuntimeStatus.message : aiRuntimeStatus.detail || aiRuntimeStatus.message
    : "AI Runtime status is unavailable.";

  const rows: Array<{ label: string; value: string; on: boolean }> = [
    { label: "Status", value: aiRuntimeStatus?.state ?? "unavailable", on: aiRuntimeStatus?.state === "installed" },
    { label: "Installed", value: aiRuntimeStatus?.installed ? "Yes" : "No", on: Boolean(aiRuntimeStatus?.installed) },
    { label: "Using", value: aiRuntimeStatus?.using ? "Yes" : "No", on: Boolean(aiRuntimeStatus?.using) },
    { label: "Installing", value: aiRuntimeStatus?.installing ? "Yes" : "No", on: Boolean(aiRuntimeStatus?.installing) }
  ];

  return (
    <div className="workspace-panel debug-workspace">
      <section className="debug-section">
        <div className="debug-section-head">
          <h2>AI Runtime</h2>
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

        <dl className="debug-status-list">
          {rows.map((row) => (
            <div key={row.label} className={`debug-status-row${row.label === "Status" && isError ? " error" : ""}`}>
              <dt>{row.label}</dt>
              <dd>
                <span className={`debug-dot${row.on ? " on" : ""}`} aria-hidden="true" />
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        <p className={`debug-message${isError ? " error" : ""}`}>{runtimeMessage}</p>
      </section>

      <PythonSettings aiRuntimeStatus={aiRuntimeStatus} onReinstall={onInstallAiRuntime} />

      <UpdateSettings />

      <section className="debug-section">
        <div className="debug-section-head">
          <h2>AI Runtime Install Log</h2>
        </div>
        <div className="debug-log-path">{aiRuntimeStatus?.logPath || "No log path available."}</div>
        <pre className="debug-log">{aiRuntimeStatus?.logTail?.length ? aiRuntimeStatus.logTail.join("\n") : "No install log yet."}</pre>
      </section>
    </div>
  );
}

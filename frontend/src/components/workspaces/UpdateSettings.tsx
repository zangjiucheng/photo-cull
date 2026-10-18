import { useEffect, useState } from "react";
import type { UpdateChannel, UpdateSettings as Settings } from "../../types";
import { Button } from "../ui/button";

const CHANNELS: Array<{ id: UpdateChannel; label: string }> = [
  { id: "stable", label: "Stable" },
  { id: "nightly", label: "Nightly" },
];

/** Pick the release channel the updater follows, and check now. */
export function UpdateSettings() {
  const bridge = window.aiCulling;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    bridge?.getUpdateSettings?.().then(setSettings).catch((err) => setError(String(err)));
  }, [bridge]);

  if (!bridge?.getUpdateSettings || !settings) return error ? <p className="debug-message error">{error}</p> : null;

  const run = async (action: () => Promise<Settings>) => {
    setBusy(true);
    setError("");
    try {
      setSettings(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="debug-section">
      <div className="debug-section-head">
        <h2>Updates</h2>
        <div className="debug-actions">
          <Button variant="outline" size="sm" disabled={busy || !settings.supported} onClick={() => void run(() => bridge.checkForUpdates())}>
            {busy ? "Checking…" : "Check for Updates"}
          </Button>
        </div>
      </div>
      <div className="python-mode" role="radiogroup" aria-label="Update channel">
        {CHANNELS.map((channel) => (
          <label key={channel.id} className={`python-mode-option${settings.channel === channel.id ? " active" : ""}`}>
            <input
              type="radio"
              name="update-channel"
              checked={settings.channel === channel.id}
              disabled={busy}
              onChange={() => void run(() => bridge.setUpdateChannel(channel.id))}
            />
            <span>{channel.label}</span>
          </label>
        ))}
      </div>
      <p className="debug-message">
        {settings.channel === "nightly"
          ? "Nightly builds are made every night from the latest code. They get fixes first but are less tested; back up your library before trying one."
          : "Stable releases only."}{" "}
        {settings.supported ? "" : " This development build does not update itself."}
      </p>
      <dl className="debug-status-list">
        <div className="debug-status-row">
          <dt>Version</dt>
          <dd>{settings.version}</dd>
        </div>
        <div className="debug-status-row">
          <dt>Commit</dt>
          <dd>
            {settings.commit ? (
              <code title={settings.commit}>
                {settings.commit.slice(0, 7)}
                {settings.dirty ? "+dirty" : ""}
              </code>
            ) : (
              "unknown"
            )}
          </dd>
        </div>
        <div className="debug-status-row">
          <dt>Built</dt>
          <dd>{settings.builtAt ? new Date(settings.builtAt).toLocaleString() : "development build"}</dd>
        </div>
      </dl>
      <div className="debug-actions">
        <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(settings.label)}>
          Copy Version
        </Button>
      </div>
      {settings.channel === "stable" && settings.version.includes("-nightly") ? (
        <p className="debug-message">You're on a nightly build; Stable picks up again at the next stable release after it.</p>
      ) : null}
      {error ? <p className="debug-message error">{error}</p> : null}
    </section>
  );
}

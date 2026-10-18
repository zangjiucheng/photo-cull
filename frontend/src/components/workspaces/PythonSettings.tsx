import { useEffect, useState } from "react";
import type { AiRuntimeStatus, PythonCheck, RuntimeSettings } from "../../types";
import { Button } from "../ui/button";

const errorText = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error));

/** Choose which Python the AI runtime is built on: found automatically, or a specific executable. */
export function PythonSettings({
  aiRuntimeStatus,
  onReinstall,
}: {
  aiRuntimeStatus: AiRuntimeStatus | null;
  onReinstall: () => void;
}) {
  const bridge = window.aiCulling;
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [mode, setMode] = useState<"auto" | "custom">("auto");
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<PythonCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    bridge?.getRuntimeSettings?.()
      .then((loaded) => {
        setSettings(loaded);
        setMode(loaded.pythonPath ? "custom" : "auto");
        setDraft(loaded.pythonPath ?? "");
      })
      .catch((err) => setError(errorText(err)));
  }, [bridge]);

  if (!bridge?.getRuntimeSettings) return null;
  if (!settings) return error ? <p className="debug-message error">{error}</p> : null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const runCheck = (command: string | null) =>
    run(async () => {
      setCheck(await bridge.checkPython(command));
    });
  const save = (command: string | null) =>
    run(async () => {
      const next = await bridge.setRuntimePython(command);
      setChanged(next.pythonPath !== settings.pythonPath);
      setSettings(next);
      setCheck(command ? await bridge.checkPython(command) : null);
    });

  const chooseMode = (next: "auto" | "custom") => {
    setMode(next);
    setCheck(null);
    setError("");
    // Automatic needs no further input, so it applies at once.
    if (next === "auto" && settings.pythonPath) void save(null);
  };
  const browse = () =>
    run(async () => {
      const picked = await bridge.choosePython();
      if (!picked) return;
      setDraft(picked);
      setCheck(await bridge.checkPython(picked));
    });

  const managed = settings.managedPython;
  const unsaved = mode === "custom" && draft.trim() !== (settings.pythonPath ?? "");
  const installed = aiRuntimeStatus?.installed;
  return (
    <section className="debug-section python-settings">
      <div className="debug-section-head">
        <h2>Python for AI Runtime</h2>
      </div>
      <p className="debug-message">
        The AI runtime needs Python {settings.supportedRange}.{" "}
        {managed
          ? `Automatic uses one already on this computer, or downloads Python ${managed.version} (${managed.megabytes} MB) into the app's data folder.`
          : "Automatic uses one already on this computer."}
      </p>
      {settings.envPython ? (
        <p className="debug-message">
          AI_RUNTIME_PYTHON is set to <code>{settings.envPython}</code>; it takes precedence over this setting.
        </p>
      ) : null}

      <div className="python-mode" role="radiogroup" aria-label="Python for AI Runtime">
        {(["auto", "custom"] as const).map((value) => (
          <label key={value} className={`python-mode-option${mode === value ? " active" : ""}`}>
            <input type="radio" name="python-mode" checked={mode === value} disabled={busy} onChange={() => chooseMode(value)} />
            <span>{value === "auto" ? "Automatic" : "Custom Python"}</span>
          </label>
        ))}
      </div>

      {mode === "custom" ? (
        <div className="python-path-row">
          <input
            className="ui-input"
            aria-label="Python executable"
            placeholder={navigator.userAgent.includes("Windows") ? "C:\\Python312\\python.exe" : "/opt/homebrew/bin/python3.12"}
            value={draft}
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
              setCheck(null);
            }}
          />
          <Button variant="outline" size="sm" disabled={busy} onClick={browse}>
            Browse…
          </Button>
          <Button variant="outline" size="sm" disabled={busy || !draft.trim()} onClick={() => void runCheck(draft.trim())}>
            Check
          </Button>
          <Button size="sm" disabled={busy || !draft.trim() || !unsaved} onClick={() => void save(draft.trim())}>
            Use This Python
          </Button>
        </div>
      ) : (
        <div className="debug-actions">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void runCheck(null)}>
            {busy ? "Searching…" : "Find Python"}
          </Button>
        </div>
      )}

      {check ? (
        <p className={`debug-message${check.supported ? "" : " error"}`}>
          {check.supported
            ? `${mode === "auto" ? "Would use" : "OK:"} Python ${check.version} (${check.command}).`
            : check.message ??
              (check.version
                ? `${check.command} is Python ${check.version}; the AI runtime needs ${settings.supportedRange}.`
                : `${check.command} did not run as Python.`)}
          {!check.supported && mode === "auto" && managed ? ` Installing will download Python ${managed.version} instead.` : ""}
        </p>
      ) : null}
      {error ? <p className="debug-message error">{error}</p> : null}

      {settings.installedWith ? (
        <p className="debug-message">
          Installed with Python {settings.installedWith.version} ({settings.installedWith.command}).
        </p>
      ) : null}
      {installed && changed ? (
        <div className="debug-actions">
          <Button size="sm" disabled={aiRuntimeStatus?.installing} onClick={onReinstall}>
            {aiRuntimeStatus?.installing ? "Reinstalling…" : "Reinstall AI Runtime"}
          </Button>
          <span className="debug-message">The installed runtime keeps its Python until you reinstall it.</span>
        </div>
      ) : null}
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { deletePreset, listPresets, renamePreset, savePresets, type EditingPreset } from "../api";
import type { ExportEnhanceSettings } from "../types";
import { cloneSettings } from "./recipe";

// Presets used to live in this device's localStorage; they move into the library database once.
const LEGACY_STORAGE = "photo-cull.editing-presets.v2";
const FILE_FORMAT = "photo-cull-presets";

function readLegacyPresets(): Array<{ name: string; settings: ExportEnhanceSettings }> {
  try {
    const list = JSON.parse(localStorage.getItem(LEGACY_STORAGE) ?? "[]");
    return Array.isArray(list)
      ? list.filter((p) => typeof p?.name === "string" && p.settings?.recipeVersion === 2)
      : [];
  } catch {
    return [];
  }
}

export function PresetManager({
  settings,
  onApply,
  onNotice,
}: {
  settings: ExportEnhanceSettings;
  onApply: (preset: ExportEnhanceSettings) => void;
  onNotice: (message: string) => void;
}) {
  const [presets, setPresets] = useState<EditingPreset[]>([]);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const legacy = readLegacyPresets();
      let list = await listPresets();
      if (legacy.length) {
        list = await savePresets(legacy);
        localStorage.removeItem(LEGACY_STORAGE);
      }
      if (!cancelled) setPresets(list);
    })().catch((error) => onNotice(error instanceof Error ? error.message : "Unable to load presets"));
    return () => {
      cancelled = true;
    };
    // Load once per editor mount; onNotice identity is not meaningful here.
  }, []);

  const run = (action: Promise<EditingPreset[]>, message: string) =>
    action
      .then((list) => {
        setPresets(list);
        onNotice(message);
      })
      .catch((error) => onNotice(error instanceof Error ? error.message : "Preset change failed"));

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(savePresets([{ name: trimmed, settings: cloneSettings(settings) }]), `Saved “${trimmed}”`);
    setName("");
  };

  const exportFile = () => {
    const payload = { format: FILE_FORMAT, version: 1, presets: presets.map(({ name, settings }) => ({ name, settings })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "photo-cull-presets.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const entries = Array.isArray(data) ? data : data?.presets;
      if (!Array.isArray(entries) || !entries.length) throw new Error("No presets found in this file");
      await run(savePresets(entries), `Imported ${entries.length} preset${entries.length === 1 ? "" : "s"}`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Unable to import presets");
    }
  };

  return (
    <div className="preset-manager">
      <div className="quick-preset-save">
        <input
          className="ui-input"
          aria-label="Preset name"
          placeholder="Name this look"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
        />
        <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" disabled={!name.trim()} onClick={save}>
          Save
        </button>
      </div>
      {presets.map((preset) =>
        renaming?.id === preset.id ? (
          <form
            className="quick-saved-preset"
            key={preset.id}
            onSubmit={(event) => {
              event.preventDefault();
              const next = renaming.name.trim();
              if (next && next !== preset.name) void run(renamePreset(preset.id, next), `Renamed to “${next}”`);
              setRenaming(null);
            }}
          >
            <input
              className="ui-input"
              aria-label={`New name for ${preset.name}`}
              autoFocus
              value={renaming.name}
              onChange={(event) => setRenaming({ id: preset.id, name: event.target.value })}
              onKeyDown={(event) => event.key === "Escape" && setRenaming(null)}
              onBlur={() => setRenaming(null)}
            />
          </form>
        ) : (
          <div className="quick-saved-preset" key={preset.id}>
            <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => onApply(preset.settings)}>
              {preset.name}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon"
              aria-label={`Rename preset ${preset.name}`}
              title="Rename"
              onClick={() => setRenaming({ id: preset.id, name: preset.name })}
            >
              ✎
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon"
              aria-label={`Delete preset ${preset.name}`}
              title="Delete"
              onClick={() => void run(deletePreset(preset.id), `Deleted “${preset.name}”`)}
            >
              ×
            </button>
          </div>
        ),
      )}
      <div className="quick-button-row">
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => fileInput.current?.click()}>
          Import…
        </button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={!presets.length} onClick={exportFile}>
          Export…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>
    </div>
  );
}

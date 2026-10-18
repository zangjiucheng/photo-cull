import { useEffect, useState } from "react";
import { createSnapshot, deleteSnapshot, listSnapshots, renameSnapshot, type PhotoSnapshot } from "../api";
import type { ExportEnhanceSettings } from "../types";
import { cloneSettings } from "./recipe";

const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Named versions of one photo's edit. Only the recipe is stored; restoring is a normal,
// undoable settings change.
export function SnapshotList({
  photoId,
  settings,
  onRestore,
  onNotice,
}: {
  photoId: string;
  settings: ExportEnhanceSettings;
  onRestore: (settings: ExportEnhanceSettings) => void;
  onNotice: (message: string) => void;
}) {
  const [snapshots, setSnapshots] = useState<PhotoSnapshot[]>([]);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSnapshots([]);
    listSnapshots(photoId)
      .then((list) => !cancelled && setSnapshots(list))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [photoId]);

  const fail = (error: unknown) => onNotice(error instanceof Error ? error.message : "Version change failed");

  const save = () => {
    const trimmed = name.trim() || `Version ${snapshots.length + 1}`;
    createSnapshot(photoId, trimmed, cloneSettings(settings))
      .then((snapshot) => {
        setSnapshots((list) => [snapshot, ...list]);
        setName("");
        onNotice(`Saved version “${snapshot.name}”`);
      })
      .catch(fail);
  };

  return (
    <div className="snapshot-list">
      <div className="quick-preset-save">
        <input
          className="ui-input"
          aria-label="Version name"
          placeholder={`Version ${snapshots.length + 1}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
        />
        <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={save}>
          Save version
        </button>
      </div>
      {snapshots.map((snapshot) =>
        renaming?.id === snapshot.id ? (
          <form
            className="quick-saved-preset"
            key={snapshot.id}
            onSubmit={(event) => {
              event.preventDefault();
              const next = renaming.name.trim();
              if (next && next !== snapshot.name)
                renameSnapshot(snapshot.id, next)
                  .then((renamed) => setSnapshots((list) => list.map((s) => (s.id === renamed.id ? renamed : s))))
                  .catch(fail);
              setRenaming(null);
            }}
          >
            <input
              className="ui-input"
              aria-label={`New name for ${snapshot.name}`}
              autoFocus
              value={renaming.name}
              onChange={(event) => setRenaming({ id: snapshot.id, name: event.target.value })}
              onKeyDown={(event) => event.key === "Escape" && setRenaming(null)}
              onBlur={() => setRenaming(null)}
            />
          </form>
        ) : (
          <div className="quick-saved-preset snapshot-row" key={snapshot.id}>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              title="Restore this version (undo brings the current edit back)"
              onClick={() => {
                onRestore(cloneSettings(snapshot.settings));
                onNotice(`Restored “${snapshot.name}”`);
              }}
            >
              {snapshot.name}
            </button>
            <time dateTime={new Date(snapshot.createdAt * 1000).toISOString()}>
              {timeFormat.format(snapshot.createdAt * 1000)}
            </time>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon"
              aria-label={`Rename version ${snapshot.name}`}
              title="Rename"
              onClick={() => setRenaming({ id: snapshot.id, name: snapshot.name })}
            >
              ✎
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon"
              aria-label={`Delete version ${snapshot.name}`}
              title="Delete"
              onClick={() =>
                deleteSnapshot(snapshot.id)
                  .then(() => setSnapshots((list) => list.filter((s) => s.id !== snapshot.id)))
                  .catch(fail)
              }
            >
              ×
            </button>
          </div>
        ),
      )}
    </div>
  );
}

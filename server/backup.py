"""Library backup and restore.

A backup is a zip with a consistent SQLite copy (library.db) and a manifest describing what it
holds: recipes by engine/profile version, presets, snapshots and the workspace folders it refers
to. Original photos are never included; workspaces point at folders that may need reconnecting
on another machine or after a disk is renamed.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import time
import zipfile
from collections import Counter
from contextlib import closing
from typing import Any

from . import db

FORMAT = "photo-cull-backup"
FORMAT_VERSION = 1
DB_ENTRY = "library.db"
MANIFEST_ENTRY = "manifest.json"


class BackupError(ValueError):
    pass


# sqlite3's context manager only commits; Windows cannot delete or replace a database file
# while a connection is still open, so every connection here is closed explicitly.
def _open(path: str) -> closing:
    return closing(sqlite3.connect(path))


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _summarize(conn: sqlite3.Connection) -> dict[str, Any]:
    recipes: Counter[str] = Counter()
    for (raw,) in conn.execute("SELECT settings FROM export_enhance_settings"):
        try:
            settings = json.loads(raw)
        except json.JSONDecodeError:
            recipes["unreadable"] += 1
            continue
        if settings.get("recipeVersion") != 2:
            recipes["legacy (v1)"] += 1
        else:
            recipes[f"engine {settings.get('engineVersion', 1)} / RAW profile {settings.get('rawProfileVersion', 1)}"] += 1
    count = lambda table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    workspaces = [
        {"id": row[0], "name": row[1], "rootPath": row[2],
         "photos": conn.execute("SELECT COUNT(*) FROM photos WHERE workspace_id = ?", (row[0],)).fetchone()[0]}
        for row in conn.execute("SELECT id, name, root_path FROM workspaces ORDER BY name")
    ]
    return {
        "counts": {"workspaces": len(workspaces), "photos": count("photos"), "recipes": sum(recipes.values()),
                   "presets": count("presets"), "snapshots": count("photo_snapshots"), "exportJobs": count("export_jobs")},
        "recipesByEngine": dict(sorted(recipes.items())),
        "presets": [row[0] for row in conn.execute("SELECT name FROM presets ORDER BY name COLLATE NOCASE")],
        "workspaces": workspaces,
    }


def create_backup(destination: str, app_version: str | None = None) -> dict[str, Any]:
    """Write a backup zip to destination and return its manifest."""
    if not destination:
        raise BackupError("destination is required")
    folder = os.path.dirname(os.path.abspath(destination))
    if not os.path.isdir(folder):
        raise BackupError("Backup folder does not exist")
    with tempfile.TemporaryDirectory() as work:
        snapshot = os.path.join(work, DB_ENTRY)
        # The SQLite backup API gives a consistent copy even while scans or edits are writing.
        with closing(db.connect()) as source, _open(snapshot) as target:
            source.backup(target)
        with _open(snapshot) as conn:
            summary = _summarize(conn)
        manifest = {
            "format": FORMAT,
            "formatVersion": FORMAT_VERSION,
            "appVersion": app_version or os.getenv("AI_CULLING_APP_VERSION") or "unknown",
            "createdAt": time.time(),
            "includesOriginals": False,
            "database": {"file": DB_ENTRY, "sha256": _sha256(snapshot), "bytes": os.path.getsize(snapshot)},
            **summary,
        }
        partial = destination + ".partial"
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(MANIFEST_ENTRY, json.dumps(manifest, indent=2))
            archive.write(snapshot, DB_ENTRY)
        os.replace(partial, destination)
    return manifest


def _extract_and_verify(path: str, work: str) -> tuple[dict[str, Any], str]:
    if not os.path.isfile(path):
        raise BackupError("Backup file not found")
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if not {MANIFEST_ENTRY, DB_ENTRY} <= names:
                raise BackupError("This is not a Photo Cull backup")
            manifest = json.loads(archive.read(MANIFEST_ENTRY))
            archive.extract(DB_ENTRY, work)
    except zipfile.BadZipFile as exc:
        raise BackupError("The backup file is damaged or not a zip archive") from exc
    if manifest.get("format") != FORMAT:
        raise BackupError("This is not a Photo Cull backup")
    if int(manifest.get("formatVersion", 0)) > FORMAT_VERSION:
        raise BackupError("This backup was made by a newer Photo Cull; update the app to restore it")
    extracted = os.path.join(work, DB_ENTRY)
    if _sha256(extracted) != manifest.get("database", {}).get("sha256"):
        raise BackupError("The backup database does not match its checksum; the file is damaged")
    with _open(extracted) as conn:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise BackupError("The backup database failed SQLite's integrity check")
    return manifest, extracted


def _with_folder_status(manifest: dict[str, Any]) -> dict[str, Any]:
    workspaces = [{**ws, "folderFound": os.path.isdir(ws.get("rootPath") or "")} for ws in manifest.get("workspaces", [])]
    return {**manifest, "workspaces": workspaces, "missingFolders": sum(not ws["folderFound"] for ws in workspaces)}


def inspect_backup(path: str) -> dict[str, Any]:
    """Validate a backup without changing anything; reports folders missing on this machine."""
    with tempfile.TemporaryDirectory() as work:
        manifest, _ = _extract_and_verify(path, work)
    return _with_folder_status(manifest)


def restore_backup(path: str) -> dict[str, Any]:
    """Replace the library with a verified backup. The current library is kept next to it first."""
    current = db.get_config().db_path
    with tempfile.TemporaryDirectory() as work:
        manifest, extracted = _extract_and_verify(path, work)
        safety = None
        if os.path.exists(current):
            safety = f"{os.path.splitext(current)[0]}.before-restore-{time.strftime('%Y%m%d-%H%M%S')}.db"
            with closing(db.connect()) as source, _open(safety) as target:
                source.backup(target)
        staged = current + ".restoring"
        shutil.copyfile(extracted, staged)
        # On Windows a background thread may hold the database open for a moment; retry briefly.
        for attempt in range(10):
            try:
                os.replace(staged, current)
                break
            except PermissionError:
                if attempt == 9:
                    os.remove(staged)
                    raise BackupError("The library is busy; wait for scanning or export to finish and try again")
                time.sleep(0.2)
    # Older backups are upgraded in place to the current schema.
    db.init_db()
    db.mark_interrupted_export_jobs()
    return {**_with_folder_status(manifest), "previousLibrary": safety}


def relocate_workspace(workspace_id: str, new_root: str, sample: int = 20) -> dict[str, Any]:
    """Point a workspace at a folder that moved, after checking its photos are really there."""
    root = os.path.realpath(os.path.abspath(os.path.expanduser(new_root or "")))
    if not os.path.isdir(root):
        raise BackupError("Folder does not exist")
    with db.connect() as conn:
        workspace = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
        if workspace is None:
            raise BackupError("Workspace not found")
        clash = conn.execute("SELECT id FROM workspaces WHERE root_path = ? AND id != ?", (root, workspace_id)).fetchone()
        if clash:
            raise BackupError("Another workspace already uses this folder")
        rows = conn.execute(
            "SELECT relative_path FROM photos WHERE workspace_id = ? ORDER BY relative_path LIMIT ?",
            (workspace_id, sample),
        ).fetchall()
    found = sum(os.path.isfile(os.path.join(root, *row["relative_path"].split("/"))) for row in rows)
    if rows and found < max(1, round(len(rows) * 0.8)):
        raise BackupError(f"Only {found} of {len(rows)} sampled photos are in that folder; choose the folder this workspace was made from")
    with db.connect() as conn:
        conn.execute("UPDATE workspaces SET root_path = ?, updated_at = ? WHERE id = ?", (root, time.time(), workspace_id))
        updated = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
    return {"workspace": db.row_to_workspace(updated), "checked": len(rows), "found": found}

from __future__ import annotations

import hashlib
import io
import os
import threading
import time
import zipfile
from collections import defaultdict
from uuid import uuid4

from PIL import Image, UnidentifiedImageError
from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from . import db, scoring
from .config import ALLOWED_EXTS, AppConfig


_config = AppConfig()
_gc_lock = threading.Lock()
_last_gc_at = 0.0


class InvalidImageError(ValueError):
    pass


class InvalidWorkspaceError(ValueError):
    pass


def configure(config: AppConfig) -> None:
    global _config
    _config = config
    os.makedirs(_config.upload_folder, exist_ok=True)


def allowed_image(filename: str) -> bool:
    _, ext = os.path.splitext(filename.lower())
    return ext in ALLOWED_EXTS


def validate_image_file(path: str) -> None:
    try:
        with Image.open(path) as img:
            img.verify()
    except (UnidentifiedImageError, OSError) as exc:
        raise InvalidImageError("File is not a valid image") from exc


def resolve_disk_path(path: str) -> str:
    if os.path.isabs(path):
        return path
    return os.path.abspath(path)


def normalize_root_path(root_path: str) -> str:
    if not root_path or not isinstance(root_path, str):
        raise InvalidWorkspaceError("root_path is required")
    resolved = os.path.realpath(os.path.abspath(os.path.expanduser(root_path)))
    if not os.path.isdir(resolved):
        raise InvalidWorkspaceError("Workspace folder does not exist")
    return resolved


def compute_content_hash(path: str) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make_photo_id(workspace_id: str, relative_path: str) -> str:
    key = f"{workspace_id}:{relative_path}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def make_workspace_id(root_path: str) -> str:
    return hashlib.sha1(root_path.encode("utf-8")).hexdigest()[:16]


def folder_name(relative_folder: str) -> str:
    if not relative_folder:
        return "Root"
    return os.path.basename(relative_folder) or relative_folder


def relative_to_workspace(path: str, root_path: str) -> str:
    resolved = os.path.realpath(os.path.abspath(path))
    try:
        common = os.path.commonpath([resolved, root_path])
    except ValueError as exc:
        raise InvalidWorkspaceError("Photo path is outside workspace") from exc
    if common != root_path:
        raise InvalidWorkspaceError("Photo path is outside workspace")
    return os.path.relpath(resolved, root_path).replace(os.sep, "/")


def create_workspace(root_path: str, name: str | None = None) -> dict:
    resolved_root = normalize_root_path(root_path)
    workspace_name = name or os.path.basename(resolved_root) or resolved_root
    row = db.upsert_workspace(make_workspace_id(resolved_root), workspace_name, resolved_root)
    scan_workspace(row["id"], force_gc=True)
    refreshed = db.fetch_workspace(row["id"])
    return db.row_to_workspace(refreshed)


def list_workspaces() -> list[dict]:
    return [db.row_to_workspace(row) for row in db.list_workspaces()]


def delete_workspace(workspace_id: str) -> bool:
    return db.delete_workspace(workspace_id)


def index_workspace_file(workspace_id: str, path: str) -> tuple[dict | None, str]:
    workspace = db.fetch_workspace(workspace_id)
    if workspace is None:
        raise InvalidWorkspaceError("Workspace not found")

    filename = os.path.basename(path)
    if filename.startswith(".") or not allowed_image(filename):
        return None, "ignored"

    resolved_path = os.path.realpath(os.path.abspath(path))
    relative_path = relative_to_workspace(resolved_path, workspace["root_path"])
    if db.is_excluded(workspace_id, relative_path):
        return None, "excluded"

    validate_image_file(resolved_path)
    relative_folder = os.path.dirname(relative_path)
    stat = os.stat(resolved_path)
    content_hash = compute_content_hash(resolved_path)
    photo_id = make_photo_id(workspace_id, relative_path)

    state = db.insert_or_update_photo(
        photo_id=photo_id,
        workspace_id=workspace_id,
        name=filename,
        path=resolved_path,
        relative_path=relative_path,
        folder=folder_name(relative_folder),
        folder_path=relative_folder,
        mtime=stat.st_mtime,
        size=stat.st_size,
        content_hash=content_hash,
    )

    row = db.fetch_photo(photo_id)
    return (db.row_to_photo(row) if row else None), state


def save_upload(file_obj: FileStorage) -> dict | None:
    safe_name = secure_filename(file_obj.filename or "")
    if not safe_name or not allowed_image(safe_name):
        return None

    upload_root = normalize_root_path(_config.upload_folder)
    workspace = db.fetch_workspace_by_root(upload_root)
    if workspace is None:
        workspace = db.upsert_workspace(make_workspace_id(upload_root), "Uploads", upload_root)

    disk_name = f"{uuid4().hex}_{safe_name}"
    path = os.path.join(upload_root, disk_name)

    try:
        file_obj.save(path)
        validate_image_file(path)
        record, _state = index_workspace_file(workspace["id"], path)
    except Exception:
        if os.path.exists(path):
            os.remove(path)
        raise

    if record is None:
        return None
    scoring.enqueue_scoring(record["id"], record["path"])
    return record


def gc_missing_photos(workspace_id: str | None = None) -> int:
    rows = db.list_photos(workspace_id)
    missing = [row["id"] for row in rows if not os.path.exists(resolve_disk_path(row["path"]))]
    removed = db.delete_photos(missing)
    if removed:
        scoring.discard_jobs(missing)
    return removed


def maybe_run_gc(workspace_id: str | None = None, force: bool = False) -> int:
    global _last_gc_at
    now = time.time()
    with _gc_lock:
        if not force and now - _last_gc_at < _config.gc_interval_seconds:
            return 0
        _last_gc_at = now
    return gc_missing_photos(workspace_id)


def scan_workspace(workspace_id: str, force_gc: bool = False) -> None:
    workspace = db.fetch_workspace(workspace_id)
    if workspace is None:
        raise InvalidWorkspaceError("Workspace not found")

    maybe_run_gc(workspace_id, force=force_gc)
    root_path = workspace["root_path"]
    for root, dirs, files in os.walk(root_path):
        dirs[:] = [dirname for dirname in dirs if not dirname.startswith(".")]
        for file_name in sorted(files):
            if file_name.startswith(".") or not allowed_image(file_name):
                continue
            path = os.path.join(root, file_name)
            try:
                record, state = index_workspace_file(workspace_id, path)
            except InvalidImageError:
                continue
            if record and state in {"inserted", "pending"}:
                scoring.enqueue_scoring(record["id"], record["path"])
    db.mark_workspace_scanned(workspace_id)


def build_library_payload(workspace_id: str | None = None) -> dict:
    workspaces = list_workspaces()
    if workspace_id is None:
        workspace_id = workspaces[0]["id"] if workspaces else None

    active_workspace = db.fetch_workspace(workspace_id) if workspace_id else None
    rows = db.list_photos(workspace_id) if workspace_id and active_workspace else []
    photos = [db.row_to_photo(row) for row in rows]
    folders = defaultdict(list)

    if photos:
        folders[""] = photos

    for photo in photos:
        if photo["folderPath"] == "":
            continue
        folders[photo["folderPath"]].append(photo)

    folder_items = []
    for folder_path, items in folders.items():
        scored = [item["score"] for item in items if item["score"] is not None]
        folder_items.append(
            {
                "path": folder_path,
                "name": folder_name(folder_path),
                "count": len(items),
                "bestScore": round(max(scored), 2) if scored else 0,
                "mtime": max(item["mtime"] for item in items),
            }
        )

    folder_items.sort(key=lambda item: (item["path"].count("/"), item["path"], item["name"]))
    summary = {
        "pending": sum(1 for photo in photos if photo["status"] == "pending"),
        "processing": sum(1 for photo in photos if photo["status"] == "processing"),
        "done": sum(1 for photo in photos if photo["status"] == "done"),
        "error": sum(1 for photo in photos if photo["status"] == "error"),
        "scoreMode": scoring.score_mode(),
        "excluded": len(db.list_excluded(workspace_id)) if workspace_id else 0,
    }
    return {
        "activeWorkspace": db.row_to_workspace(active_workspace) if active_workspace else None,
        "workspaces": workspaces,
        "folders": folder_items,
        "photos": photos,
        "summary": summary,
    }


def build_export_zip(selected_ids: list[str]) -> io.BytesIO:
    mem = io.BytesIO()
    with zipfile.ZipFile(mem, "w") as zip_file:
        for photo_id in selected_ids:
            row = db.fetch_photo(photo_id)
            if not row:
                continue
            path = resolve_disk_path(row["path"])
            if os.path.exists(path):
                zip_file.write(path, row["relative_path"] or row["name"])
    mem.seek(0)
    return mem


def exclude_photo_files(photo_ids: list[str]) -> dict:
    result = db.exclude_photos(photo_ids)
    scoring.discard_jobs(result["excludedIds"])
    return result


def restore_excluded(workspace_id: str, relative_paths: list[str] | None = None) -> dict:
    workspace = db.fetch_workspace(workspace_id)
    if workspace is None:
        raise InvalidWorkspaceError("Workspace not found")
    restored_paths = db.restore_excluded(workspace_id, relative_paths)
    scan_workspace(workspace_id, force_gc=True)
    return {"restoredPaths": restored_paths, "restored": len(restored_paths)}

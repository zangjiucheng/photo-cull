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
_initial_scan_lock = threading.Lock()
_last_gc_at = 0.0
_initial_scan_done = False


class InvalidImageError(ValueError):
    pass


def configure(config: AppConfig) -> None:
    global _config, _initial_scan_done
    _config = config
    _initial_scan_done = False
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


def compute_content_hash(path: str) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make_photo_id(path: str) -> str:
    relative_path = os.path.relpath(path, _config.upload_folder).replace(os.sep, "/")
    return hashlib.sha1(relative_path.encode("utf-8")).hexdigest()[:16]


def folder_name(relative_folder: str) -> str:
    if not relative_folder:
        return "Root"
    return os.path.basename(relative_folder) or relative_folder


def index_uploaded_file(path: str, photo_id: str | None = None, display_name: str | None = None) -> tuple[dict | None, str]:
    filename = os.path.basename(path)
    if not allowed_image(filename):
        return None, "ignored"
    validate_image_file(path)

    resolved_id = photo_id or make_photo_id(path)
    name = display_name or filename
    relative_path = os.path.relpath(path, _config.upload_folder).replace(os.sep, "/")
    relative_folder = os.path.dirname(relative_path)
    stat = os.stat(path)
    content_hash = compute_content_hash(path)

    state = db.insert_or_update_photo(
        photo_id=resolved_id,
        name=name,
        path=path,
        relative_path=relative_path,
        folder=folder_name(relative_folder),
        folder_path=relative_folder,
        mtime=stat.st_mtime,
        size=stat.st_size,
        content_hash=content_hash,
    )

    row = db.fetch_photo(resolved_id)
    return (db.row_to_photo(row) if row else None), state


def save_upload(file_obj: FileStorage) -> dict | None:
    safe_name = secure_filename(file_obj.filename or "")
    if not safe_name or not allowed_image(safe_name):
        return None

    photo_id = uuid4().hex
    disk_name = f"{photo_id}_{safe_name}"
    path = os.path.join(_config.upload_folder, disk_name)

    try:
        file_obj.save(path)
        validate_image_file(path)
        record, _state = index_uploaded_file(path, photo_id=photo_id, display_name=safe_name)
    except Exception:
        if os.path.exists(path):
            os.remove(path)
        raise

    if record is None:
        return None
    scoring.enqueue_scoring(record["id"], record["path"])
    return record


def gc_missing_photos() -> int:
    rows = db.list_photos()
    missing = [row["id"] for row in rows if not os.path.exists(resolve_disk_path(row["path"]))]
    removed = db.delete_photos(missing)
    if removed:
        scoring.discard_jobs(missing)
    return removed


def maybe_run_gc(force: bool = False) -> int:
    global _last_gc_at
    now = time.time()
    with _gc_lock:
        if not force and now - _last_gc_at < _config.gc_interval_seconds:
            return 0
        _last_gc_at = now
    return gc_missing_photos()


def scan_upload_folder(force_gc: bool = False) -> None:
    maybe_run_gc(force=force_gc)
    for root, _dirs, files in os.walk(_config.upload_folder):
        for file_name in sorted(files):
            if not allowed_image(file_name):
                continue
            path = os.path.join(root, file_name)
            try:
                record, state = index_uploaded_file(path)
            except InvalidImageError:
                continue
            if record and state in {"inserted", "pending"}:
                scoring.enqueue_scoring(record["id"], record["path"])


def ensure_initial_scan() -> None:
    global _initial_scan_done
    if _initial_scan_done:
        return
    with _initial_scan_lock:
        if _initial_scan_done:
            return
        scan_upload_folder(force_gc=False)
        _initial_scan_done = True


def build_library_payload() -> dict:
    rows = db.list_photos()
    photos = [db.row_to_photo(row) for row in rows]
    folders = defaultdict(list)

    for photo in photos:
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
    }
    return {"folders": folder_items, "photos": photos, "summary": summary}


def build_export_zip(selected_ids: list[str]) -> io.BytesIO:
    mem = io.BytesIO()
    with zipfile.ZipFile(mem, "w") as zip_file:
        for photo_id in selected_ids:
            row = db.fetch_photo(photo_id)
            if not row:
                continue
            path = resolve_disk_path(row["path"])
            if os.path.exists(path):
                zip_file.write(path, row["name"])
    mem.seek(0)
    return mem


def delete_photo_files(photo_ids: list[str]) -> dict:
    deleted_ids = []
    missing_ids = []
    deleted_files = 0

    for photo_id in photo_ids:
        row = db.fetch_photo(photo_id)
        if not row:
            missing_ids.append(photo_id)
            continue

        path = resolve_disk_path(row["path"])
        if os.path.exists(path):
            os.remove(path)
            deleted_files += 1
        deleted_ids.append(photo_id)

    removed_records = db.delete_photos(deleted_ids)
    scoring.discard_jobs(deleted_ids)
    return {
        "deletedIds": deleted_ids,
        "missingIds": missing_ids,
        "deletedFiles": deleted_files,
        "deletedRecords": removed_records,
    }

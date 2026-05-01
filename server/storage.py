from __future__ import annotations

import hashlib
import io
import os
import threading
import time
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from PIL import Image, UnidentifiedImageError
from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from . import db, events, raw_pipeline, scoring, similarity
from .config import ALLOWED_EXTS, AppConfig


_config = AppConfig()
_gc_lock = threading.Lock()
_last_gc_at = 0.0
_scan_executor = ThreadPoolExecutor(max_workers=1)
_scan_lock = threading.Lock()
_scan_jobs: dict[str, dict] = {}


class InvalidImageError(ValueError):
    pass


class InvalidWorkspaceError(ValueError):
    pass


def configure(config: AppConfig) -> None:
    global _config, _scan_executor, _scan_jobs
    _config = config
    _scan_executor.shutdown(wait=False, cancel_futures=True)
    _scan_executor = ThreadPoolExecutor(max_workers=1)
    _scan_jobs = {}
    os.makedirs(_config.upload_folder, exist_ok=True)
    raw_pipeline.configure(config)


def allowed_image(filename: str) -> bool:
    _, ext = os.path.splitext(filename.lower())
    return ext in ALLOWED_EXTS


def validate_image_file(path: str) -> None:
    raw_pipeline._register_heif_opener()
    if raw_pipeline.is_raw_image(path):
        try:
            raw_pipeline.validate_image_file(path)
        except raw_pipeline.InvalidRawImageError as exc:
            raise InvalidImageError("File is not a valid image") from exc
        return

    try:
        with Image.open(path) as img:
            img.verify()
    except (UnidentifiedImageError, OSError) as exc:
        raise InvalidImageError("File is not a valid image") from exc


def display_path_for_photo_row(row) -> str:
    try:
        return raw_pipeline.display_path_for_row(row)
    except raw_pipeline.InvalidRawImageError as exc:
        raise InvalidImageError("File is not a valid image") from exc


def _enqueue_photo_scoring(row) -> bool:
    scoring.enqueue_scoring(row["id"], row["path"])
    return True


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
    start_workspace_scan(row["id"])
    refreshed = db.fetch_workspace(row["id"])
    return db.row_to_workspace(refreshed)


def list_workspaces() -> list[dict]:
    return [db.row_to_workspace(row) for row in db.list_workspaces()]


def delete_workspace(workspace_id: str) -> bool:
    refs = db.workspace_cache_refs(workspace_id)
    deleted = db.delete_workspace(workspace_id)
    if not deleted:
        return False

    scoring.discard_jobs(refs["photoIds"])
    raw_pipeline.delete_cached_renders(refs["contentHashes"])
    similarity.clear_similarity_cache()
    with _scan_lock:
        _scan_jobs.pop(workspace_id, None)
    events.publish("library:update", workspace_id, {"source": "workspace", "status": "deleted"})
    return True


def _idle_scan_state() -> dict:
    return {
        "active": False,
        "indexed": 0,
        "totalDiscovered": 0,
        "status": "idle",
        "startedAt": None,
        "finishedAt": None,
        "error": None,
    }


def _public_scan_state(state: dict | None) -> dict:
    if state is None:
        return _idle_scan_state()
    return {
        "active": bool(state.get("active")),
        "indexed": int(state.get("indexed") or 0),
        "totalDiscovered": int(state.get("totalDiscovered") or 0),
        "status": state.get("status") or "idle",
        "startedAt": state.get("startedAt"),
        "finishedAt": state.get("finishedAt"),
        "error": state.get("error"),
    }


def get_scan_state(workspace_id: str | None) -> dict:
    if not workspace_id:
        return _idle_scan_state()
    with _scan_lock:
        return _public_scan_state(_scan_jobs.get(workspace_id))


def _set_scan_state(workspace_id: str, **updates) -> None:
    with _scan_lock:
        state = _scan_jobs.setdefault(workspace_id, _idle_scan_state())
        state.update(updates)
    events.publish("library:update", workspace_id, {"source": "indexing", "status": updates.get("status")})


def _increment_scan_state(workspace_id: str, key: str, amount: int = 1) -> None:
    should_publish = False
    with _scan_lock:
        state = _scan_jobs.setdefault(workspace_id, _idle_scan_state())
        state[key] = int(state.get(key) or 0) + amount
        if key == "indexed":
            indexed = int(state.get("indexed") or 0)
            should_publish = indexed <= 5 or indexed % 10 == 0 or indexed >= int(state.get("totalDiscovered") or 0)
    if should_publish:
        events.publish("library:update", workspace_id, {"source": "indexing", "status": "indexing"})


def _run_scan_job(workspace_id: str) -> None:
    _set_scan_state(
        workspace_id,
        active=True,
        indexed=0,
        totalDiscovered=0,
        status="indexing",
        startedAt=time.time(),
        finishedAt=None,
        error=None,
    )
    try:
        scan_workspace(workspace_id, force_gc=True, update_progress=True)
    except Exception as exc:
        _set_scan_state(workspace_id, active=False, status="error", finishedAt=time.time(), error=str(exc)[:500])
        return
    _set_scan_state(workspace_id, active=False, status="done", finishedAt=time.time(), error=None)


def start_workspace_scan(workspace_id: str) -> dict:
    workspace = db.fetch_workspace(workspace_id)
    if workspace is None:
        raise InvalidWorkspaceError("Workspace not found")
    with _scan_lock:
        state = _scan_jobs.get(workspace_id)
        if state and state.get("active"):
            return _public_scan_state(state)
        _scan_jobs[workspace_id] = {
            "active": True,
            "indexed": 0,
            "totalDiscovered": 0,
            "status": "indexing",
            "startedAt": time.time(),
            "finishedAt": None,
            "error": None,
        }
    _scan_executor.submit(_run_scan_job, workspace_id)
    events.publish("library:update", workspace_id, {"source": "indexing", "status": "indexing"})
    return get_scan_state(workspace_id)


def wait_for_scan(workspace_id: str, timeout: float = 5.0) -> dict:
    started_at = time.time()
    while time.time() - started_at < timeout:
        state = get_scan_state(workspace_id)
        if not state["active"]:
            return state
        time.sleep(0.02)
    return get_scan_state(workspace_id)


def _match_missing_by_hash(rows, content_hash: str, filename: str, matched_keys: set[str], key_field: str):
    candidates = [
        row for row in rows
        if row["content_hash"] == content_hash and row[key_field] not in matched_keys
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda row: (row["name"] != filename, row["relative_path"]))
    return candidates[0]


def _backfill_excluded_hashes(rows) -> None:
    for row in rows:
        if row["content_hash"]:
            continue
        path = resolve_disk_path(row["path"])
        if not os.path.exists(path):
            continue
        try:
            db.update_excluded_hash(row["workspace_id"], row["relative_path"], compute_content_hash(path))
        except OSError:
            continue


def index_workspace_file(
    workspace_id: str,
    path: str,
    moved_photo_candidates=None,
    matched_photo_ids: set[str] | None = None,
    moved_excluded_candidates=None,
    matched_excluded_paths: set[str] | None = None,
) -> tuple[dict | None, str]:
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

    relative_folder = os.path.dirname(relative_path)
    stat = os.stat(resolved_path)
    photo_id = make_photo_id(workspace_id, relative_path)
    exact_photo = db.fetch_photo_by_relative_path(workspace_id, relative_path)

    if exact_photo and float(exact_photo["mtime"]) == stat.st_mtime and int(exact_photo["size"]) == stat.st_size:
        if exact_photo["score"] is None and exact_photo["status"] != "processing":
            return db.row_to_photo(exact_photo), "pending"
        return db.row_to_photo(exact_photo), "unchanged"

    validate_image_file(resolved_path)
    content_hash = compute_content_hash(resolved_path)

    if moved_excluded_candidates is not None and matched_excluded_paths is not None:
        excluded_match = _match_missing_by_hash(moved_excluded_candidates, content_hash, filename, matched_excluded_paths, "relative_path")
        if excluded_match and db.move_excluded_photo(
            workspace_id=workspace_id,
            old_relative_path=excluded_match["relative_path"],
            new_relative_path=relative_path,
            name=filename,
            path=resolved_path,
            content_hash=content_hash,
        ):
            matched_excluded_paths.add(excluded_match["relative_path"])
            return None, "excluded"

    if exact_photo is None and moved_photo_candidates is not None and matched_photo_ids is not None:
        photo_match = _match_missing_by_hash(moved_photo_candidates, content_hash, filename, matched_photo_ids, "id")
        if photo_match and db.move_photo_record(
            old_photo_id=photo_match["id"],
            new_photo_id=photo_id,
            name=filename,
            path=resolved_path,
            relative_path=relative_path,
            folder=folder_name(relative_folder),
            folder_path=relative_folder,
            mtime=stat.st_mtime,
            size=stat.st_size,
            content_hash=content_hash,
        ):
            matched_photo_ids.add(photo_match["id"])
            row = db.fetch_photo(photo_id)
            return (db.row_to_photo(row) if row else None), "moved"

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
    row = db.fetch_photo(record["id"])
    if row:
        _enqueue_photo_scoring(row)
    return record


def gc_missing_photos(workspace_id: str | None = None) -> int:
    rows = db.list_photos(workspace_id)
    missing = [row["id"] for row in rows if not os.path.exists(resolve_disk_path(row["path"]))]
    removed = db.delete_photos(missing)
    if removed:
        scoring.discard_jobs(missing)
    return removed


def collect_missing_photo_ids(workspace_id: str | None = None) -> list[str]:
    rows = db.list_photos(workspace_id)
    return [row["id"] for row in rows if not os.path.exists(resolve_disk_path(row["path"]))]


def maybe_run_gc(workspace_id: str | None = None, force: bool = False) -> int:
    global _last_gc_at
    now = time.time()
    with _gc_lock:
        if not force and now - _last_gc_at < _config.gc_interval_seconds:
            return 0
        _last_gc_at = now
    return gc_missing_photos(workspace_id)


def scan_workspace(workspace_id: str, force_gc: bool = False, update_progress: bool = False) -> None:
    workspace = db.fetch_workspace(workspace_id)
    if workspace is None:
        raise InvalidWorkspaceError("Workspace not found")

    photo_rows = db.list_photos(workspace_id)
    moved_photo_candidates = [
        row for row in photo_rows
        if row["content_hash"] and not os.path.exists(resolve_disk_path(row["path"]))
    ]
    excluded_rows = db.list_excluded(workspace_id)
    _backfill_excluded_hashes(excluded_rows)
    excluded_rows = db.list_excluded(workspace_id)
    moved_excluded_candidates = [
        row for row in excluded_rows
        if row["content_hash"] and not os.path.exists(resolve_disk_path(row["path"]))
    ]
    matched_photo_ids: set[str] = set()
    matched_excluded_paths: set[str] = set()
    root_path = workspace["root_path"]
    for root, dirs, files in os.walk(root_path):
        dirs[:] = [dirname for dirname in dirs if not dirname.startswith(".")]
        for file_name in sorted(files):
            if file_name.startswith(".") or not allowed_image(file_name):
                continue
            if update_progress:
                _increment_scan_state(workspace_id, "totalDiscovered")
            path = os.path.join(root, file_name)
            try:
                record, state = index_workspace_file(
                    workspace_id,
                    path,
                    moved_photo_candidates=moved_photo_candidates,
                    matched_photo_ids=matched_photo_ids,
                    moved_excluded_candidates=moved_excluded_candidates,
                    matched_excluded_paths=matched_excluded_paths,
                )
            except InvalidImageError:
                if update_progress:
                    _increment_scan_state(workspace_id, "indexed")
                continue
            if record and state in {"inserted", "pending"}:
                row = db.fetch_photo(record["id"])
                if row:
                    _enqueue_photo_scoring(row)
            if update_progress:
                _increment_scan_state(workspace_id, "indexed")
    missing_ids = collect_missing_photo_ids(workspace_id)
    if missing_ids:
        removed = db.delete_photos(missing_ids)
        if removed:
            scoring.discard_jobs(missing_ids)
    db.mark_workspace_scanned(workspace_id)


def build_library_payload(workspace_id: str | None = None) -> dict:
    workspaces = list_workspaces()
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
        "indexing": get_scan_state(workspace_id),
    }
    return {
        "activeWorkspace": db.row_to_workspace(active_workspace) if active_workspace else None,
        "workspaces": workspaces,
        "folders": folder_items,
        "photos": photos,
        "summary": summary,
        "exportQueue": db.list_export_queue(workspace_id) if workspace_id else [],
    }


def set_export_queue(workspace_id: str, photo_ids: list[str]) -> dict:
    workspace = db.fetch_workspace(workspace_id)
    if workspace is None:
        raise InvalidWorkspaceError("Workspace not found")
    ids = db.set_export_queue(workspace_id, photo_ids)
    events.publish("library:update", workspace_id, {"source": "exportQueue", "count": len(ids)})
    return {"workspaceId": workspace_id, "ids": ids}


def build_export_zip(selected_ids: list[str]) -> io.BytesIO:
    mem = io.BytesIO()
    with zipfile.ZipFile(mem, "w") as zip_file:
        for photo_id in dict.fromkeys(selected_ids):
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


def rescore_workspace(workspace_id: str) -> dict:
    workspace = db.fetch_workspace(workspace_id)
    if workspace is None:
        raise InvalidWorkspaceError("Workspace not found")

    rows = db.list_photos(workspace_id)
    existing_rows = [row for row in rows if os.path.exists(resolve_disk_path(row["path"]))]
    photo_ids = [row["id"] for row in existing_rows]
    reset_count = db.reset_auto_scores(photo_ids)
    queued_count = 0
    for row in existing_rows:
        if _enqueue_photo_scoring(row):
            queued_count += 1
    return {"queued": queued_count, "reset": reset_count}

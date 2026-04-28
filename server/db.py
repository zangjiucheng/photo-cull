from __future__ import annotations

import os
import json
import sqlite3
import time
from collections.abc import Iterable
from typing import Any

from .config import AppConfig


_config = AppConfig()


def configure(config: AppConfig) -> None:
    global _config
    _config = config
    db_dir = os.path.dirname(_config.db_path)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)


def get_config() -> AppConfig:
    return _config


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_config.db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        photos_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(photos)").fetchall()
        }
        has_workspace_schema = bool(photos_columns) and "workspace_id" in photos_columns
        if photos_columns and not has_workspace_schema:
            conn.execute("DROP TABLE IF EXISTS photos")
            conn.execute("DROP TABLE IF EXISTS excluded_photos")
            conn.execute("DROP TABLE IF EXISTS workspaces")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                root_path TEXT NOT NULL UNIQUE,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                last_scanned_at REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                folder TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                mtime REAL NOT NULL,
                size INTEGER NOT NULL,
                content_hash TEXT,
                score REAL,
                score_details TEXT,
                manual_score REAL,
                orientation_override INTEGER,
                rating INTEGER,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(workspace_id, relative_path)
            )
            """
        )
        photos_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(photos)").fetchall()
        }
        if "score_details" not in photos_columns:
            conn.execute("ALTER TABLE photos ADD COLUMN score_details TEXT")
        if "orientation_override" not in photos_columns:
            conn.execute("ALTER TABLE photos ADD COLUMN orientation_override INTEGER")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS excluded_photos (
                workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                content_hash TEXT,
                excluded_at REAL NOT NULL,
                PRIMARY KEY(workspace_id, relative_path)
            )
            """
        )
        excluded_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(excluded_photos)").fetchall()
        }
        if "content_hash" not in excluded_columns:
            conn.execute("ALTER TABLE excluded_photos ADD COLUMN content_hash TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_workspace_folder ON photos(workspace_id, folder_path)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_workspace_status ON photos(workspace_id, status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_workspace_rating ON photos(workspace_id, rating)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_workspace_hash ON photos(workspace_id, content_hash)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_excluded_workspace_hash ON excluded_photos(workspace_id, content_hash)")


def row_to_workspace(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "rootPath": row["root_path"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastScannedAt": row["last_scanned_at"],
    }


def row_to_photo(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "workspaceId": row["workspace_id"],
        "name": row["name"],
        "score": row["score"],
        "manualScore": row["manual_score"],
        "orientationOverride": row["orientation_override"],
        "path": row["path"],
        "url": f"/api/photos/{row['id']}/image?v={int(row['updated_at'] * 1000)}",
        "folder": row["folder"],
        "folderPath": row["folder_path"],
        "relativePath": row["relative_path"],
        "mtime": row["mtime"],
        "size": row["size"],
        "decision": None,
        "rating": row["rating"],
        "status": row["status"],
        "error": row["error"],
    }


def fetch_workspace(workspace_id: str) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()


def fetch_workspace_by_root(root_path: str) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute("SELECT * FROM workspaces WHERE root_path = ?", (root_path,)).fetchone()


def list_workspaces() -> list[sqlite3.Row]:
    with connect() as conn:
        return conn.execute("SELECT * FROM workspaces ORDER BY updated_at DESC, name ASC").fetchall()


def upsert_workspace(workspace_id: str, name: str, root_path: str) -> sqlite3.Row:
    now = time.time()
    with connect() as conn:
        row = conn.execute("SELECT * FROM workspaces WHERE root_path = ?", (root_path,)).fetchone()
        if row is None:
            conn.execute(
                """
                INSERT INTO workspaces (id, name, root_path, created_at, updated_at, last_scanned_at)
                VALUES (?, ?, ?, ?, ?, NULL)
                """,
                (workspace_id, name, root_path, now, now),
            )
            return conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()

        conn.execute(
            "UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?",
            (name or row["name"], now, row["id"]),
        )
        return conn.execute("SELECT * FROM workspaces WHERE id = ?", (row["id"],)).fetchone()


def mark_workspace_scanned(workspace_id: str) -> None:
    now = time.time()
    with connect() as conn:
        conn.execute(
            "UPDATE workspaces SET last_scanned_at = ?, updated_at = ? WHERE id = ?",
            (now, now, workspace_id),
        )


def delete_workspace(workspace_id: str) -> bool:
    with connect() as conn:
        row = conn.execute("SELECT id FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
        if row is None:
            return False
        conn.execute("DELETE FROM workspaces WHERE id = ?", (workspace_id,))
    return True


def fetch_photo(photo_id: str) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()


def list_photos(workspace_id: str | None = None) -> list[sqlite3.Row]:
    with connect() as conn:
        if workspace_id is None:
            return conn.execute("SELECT * FROM photos ORDER BY workspace_id ASC, relative_path ASC").fetchall()
        return conn.execute(
            "SELECT * FROM photos WHERE workspace_id = ? ORDER BY relative_path ASC",
            (workspace_id,),
        ).fetchall()


def list_excluded(workspace_id: str) -> list[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM excluded_photos WHERE workspace_id = ? ORDER BY relative_path ASC",
            (workspace_id,),
        ).fetchall()


def is_excluded(workspace_id: str, relative_path: str) -> bool:
    with connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM excluded_photos WHERE workspace_id = ? AND relative_path = ?",
            (workspace_id, relative_path),
        ).fetchone()
    return row is not None


def fetch_photo_by_relative_path(workspace_id: str, relative_path: str) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM photos WHERE workspace_id = ? AND relative_path = ?",
            (workspace_id, relative_path),
        ).fetchone()


def move_photo_record(
    old_photo_id: str,
    new_photo_id: str,
    name: str,
    path: str,
    relative_path: str,
    folder: str,
    folder_path: str,
    mtime: float,
    size: int,
    content_hash: str,
) -> bool:
    now = time.time()
    with connect() as conn:
        old_row = conn.execute("SELECT * FROM photos WHERE id = ?", (old_photo_id,)).fetchone()
        if old_row is None:
            return False
        if old_photo_id != new_photo_id:
            conflict = conn.execute("SELECT id FROM photos WHERE id = ?", (new_photo_id,)).fetchone()
            if conflict is not None:
                return False
        relative_conflict = conn.execute(
            "SELECT id FROM photos WHERE workspace_id = ? AND relative_path = ? AND id != ?",
            (old_row["workspace_id"], relative_path, old_photo_id),
        ).fetchone()
        if relative_conflict is not None:
            return False
        conn.execute(
            """
            UPDATE photos
            SET id = ?, name = ?, path = ?, relative_path = ?, folder = ?, folder_path = ?,
                mtime = ?, size = ?, content_hash = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                new_photo_id,
                name,
                path,
                relative_path,
                folder,
                folder_path,
                mtime,
                size,
                content_hash,
                now,
                old_photo_id,
            ),
        )
    return True


def insert_or_update_photo(
    photo_id: str,
    workspace_id: str,
    name: str,
    path: str,
    relative_path: str,
    folder: str,
    folder_path: str,
    mtime: float,
    size: int,
    content_hash: str,
) -> str:
    now = time.time()
    with connect() as conn:
        row = conn.execute(
            "SELECT id, score, status, content_hash FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        if row is None:
            conn.execute(
                """
                INSERT INTO photos (
                    id, workspace_id, name, path, relative_path, folder, folder_path,
                    mtime, size, content_hash, score, score_details, status, error, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)
                """,
                (
                    photo_id,
                    workspace_id,
                    name,
                    path,
                    relative_path,
                    folder,
                    folder_path,
                    mtime,
                    size,
                    content_hash,
                    now,
                    now,
                ),
            )
            return "inserted"

        conn.execute(
            """
            UPDATE photos
            SET name = ?, path = ?, relative_path = ?, folder = ?, folder_path = ?,
                mtime = ?, size = ?, content_hash = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, path, relative_path, folder, folder_path, mtime, size, content_hash, now, photo_id),
        )

        if row["content_hash"] != content_hash and row["status"] != "processing":
            conn.execute(
                "UPDATE photos SET score = NULL, score_details = NULL, status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
                (now, photo_id),
            )
            return "pending"

        if row["score"] is None and row["status"] != "processing":
            conn.execute(
                "UPDATE photos SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
                (now, photo_id),
            )
            return "pending"
    return "updated"


def update_decision(photo_id: str, decision: str | None) -> bool:
    return fetch_photo(photo_id) is not None


def update_rating(photo_id: str, rating: int | None) -> bool:
    now = time.time()
    with connect() as conn:
        row = conn.execute("SELECT id FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if row is None:
            return False
        conn.execute("UPDATE photos SET rating = ?, updated_at = ? WHERE id = ?", (rating, now, photo_id))
    return True


def update_manual_score(photo_id: str, manual_score: float | None) -> bool:
    now = time.time()
    with connect() as conn:
        row = conn.execute("SELECT id FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if row is None:
            return False
        conn.execute(
            "UPDATE photos SET manual_score = ?, status = 'done', error = NULL, updated_at = ? WHERE id = ?",
            (manual_score, now, photo_id),
        )
    return True


def update_orientation_override(photo_id: str, orientation_override: int | None) -> bool:
    now = time.time()
    with connect() as conn:
        row = conn.execute("SELECT id FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if row is None:
            return False
        conn.execute(
            "UPDATE photos SET orientation_override = ?, updated_at = ? WHERE id = ?",
            (orientation_override, now, photo_id),
        )
    return True


def mark_processing(photo_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE photos SET status = 'processing', error = NULL, updated_at = ? WHERE id = ?",
            (time.time(), photo_id),
        )


def mark_done(photo_id: str, score_value: float, score_details: Any | None = None) -> None:
    details_json = json.dumps(score_details, sort_keys=True) if score_details is not None else None
    with connect() as conn:
        conn.execute(
            "UPDATE photos SET score = ?, score_details = ?, status = 'done', error = NULL, updated_at = ? WHERE id = ?",
            (round(float(score_value), 2), details_json, time.time(), photo_id),
        )


def reset_auto_scores(photo_ids: Iterable[str]) -> int:
    ids = list(dict.fromkeys(photo_ids))
    if not ids:
        return 0
    now = time.time()
    with connect() as conn:
        conn.executemany(
            "UPDATE photos SET score = NULL, score_details = NULL, status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
            [(now, photo_id) for photo_id in ids],
        )
        return conn.total_changes


def mark_error(photo_id: str, message: object) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE photos SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
            (str(message)[:500], time.time(), photo_id),
        )


def exclude_photos(photo_ids: Iterable[str]) -> dict[str, Any]:
    ids = list(photo_ids)
    excluded_ids: list[str] = []
    missing_ids: list[str] = []
    now = time.time()
    with connect() as conn:
        for photo_id in ids:
            row = conn.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()
            if row is None:
                missing_ids.append(photo_id)
                continue
            conn.execute(
                """
                INSERT OR REPLACE INTO excluded_photos
                    (workspace_id, relative_path, name, path, content_hash, excluded_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (row["workspace_id"], row["relative_path"], row["name"], row["path"], row["content_hash"], now),
            )
            conn.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
            excluded_ids.append(photo_id)
    return {
        "excludedIds": excluded_ids,
        "deletedIds": excluded_ids,
        "missingIds": missing_ids,
        "deletedFiles": 0,
        "deletedRecords": len(excluded_ids),
    }


def delete_photos(photo_ids: Iterable[str]) -> int:
    ids = list(photo_ids)
    if not ids:
        return 0
    with connect() as conn:
        conn.executemany("DELETE FROM photos WHERE id = ?", [(photo_id,) for photo_id in ids])
    return len(ids)


def update_excluded_hash(workspace_id: str, relative_path: str, content_hash: str) -> None:
    with connect() as conn:
        conn.execute(
            """
            UPDATE excluded_photos
            SET content_hash = ?
            WHERE workspace_id = ? AND relative_path = ? AND content_hash IS NULL
            """,
            (content_hash, workspace_id, relative_path),
        )


def move_excluded_photo(
    workspace_id: str,
    old_relative_path: str,
    new_relative_path: str,
    name: str,
    path: str,
    content_hash: str,
) -> bool:
    now = time.time()
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM excluded_photos WHERE workspace_id = ? AND relative_path = ?",
            (workspace_id, old_relative_path),
        ).fetchone()
        if row is None:
            return False
        if old_relative_path != new_relative_path:
            conflict = conn.execute(
                "SELECT 1 FROM excluded_photos WHERE workspace_id = ? AND relative_path = ?",
                (workspace_id, new_relative_path),
            ).fetchone()
            if conflict is not None:
                return False
        conn.execute(
            """
            UPDATE excluded_photos
            SET relative_path = ?, name = ?, path = ?, content_hash = ?, excluded_at = ?
            WHERE workspace_id = ? AND relative_path = ?
            """,
            (new_relative_path, name, path, content_hash, now, workspace_id, old_relative_path),
        )
    return True


def restore_excluded(workspace_id: str, relative_paths: Iterable[str] | None = None) -> list[str]:
    restored: list[str] = []
    with connect() as conn:
        if relative_paths is None:
            rows = conn.execute(
                "SELECT relative_path FROM excluded_photos WHERE workspace_id = ?",
                (workspace_id,),
            ).fetchall()
        else:
            paths = list(relative_paths)
            rows = [{"relative_path": path} for path in paths]
        for row in rows:
            conn.execute(
                "DELETE FROM excluded_photos WHERE workspace_id = ? AND relative_path = ?",
                (workspace_id, row["relative_path"]),
            )
            restored.append(row["relative_path"])
    return restored


def count_photos_by_status(status: str | None = None) -> int:
    with connect() as conn:
        if status is None:
            return conn.execute("SELECT COUNT(*) AS c FROM photos").fetchone()["c"]
        return conn.execute("SELECT COUNT(*) AS c FROM photos WHERE status = ?", (status,)).fetchone()["c"]

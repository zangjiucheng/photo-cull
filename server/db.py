from __future__ import annotations

import os
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
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                folder TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                mtime REAL NOT NULL,
                size INTEGER NOT NULL,
                content_hash TEXT,
                score REAL,
                manual_score REAL,
                decision TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(photos)").fetchall()}
        if "decision" not in columns:
            conn.execute("ALTER TABLE photos ADD COLUMN decision TEXT")
        if "content_hash" not in columns:
            conn.execute("ALTER TABLE photos ADD COLUMN content_hash TEXT")
        if "manual_score" not in columns:
            conn.execute("ALTER TABLE photos ADD COLUMN manual_score REAL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_folder_path ON photos(folder_path)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status)")


def row_to_photo(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "score": row["score"],
        "manualScore": row["manual_score"],
        "path": row["path"],
        "url": f"/api/photos/{row['id']}/image",
        "folder": row["folder"],
        "folderPath": row["folder_path"],
        "relativePath": row["relative_path"],
        "mtime": row["mtime"],
        "size": row["size"],
        "decision": row["decision"],
        "status": row["status"],
        "error": row["error"],
    }


def fetch_photo(photo_id: str) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()


def list_photos() -> list[sqlite3.Row]:
    with connect() as conn:
        return conn.execute("SELECT * FROM photos ORDER BY relative_path ASC").fetchall()


def insert_or_update_photo(
    photo_id: str,
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
                    id, name, path, relative_path, folder, folder_path, mtime, size,
                    content_hash, score, decision, status, error, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)
                """,
                (photo_id, name, path, relative_path, folder, folder_path, mtime, size, content_hash, now, now),
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
                "UPDATE photos SET score = NULL, status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
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
    now = time.time()
    with connect() as conn:
        row = conn.execute("SELECT id FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if row is None:
            return False
        conn.execute("UPDATE photos SET decision = ?, updated_at = ? WHERE id = ?", (decision, now, photo_id))
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


def mark_processing(photo_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE photos SET status = 'processing', error = NULL, updated_at = ? WHERE id = ?",
            (time.time(), photo_id),
        )


def mark_done(photo_id: str, score_value: float) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE photos SET score = ?, status = 'done', error = NULL, updated_at = ? WHERE id = ?",
            (round(float(score_value), 2), time.time(), photo_id),
        )


def mark_error(photo_id: str, message: object) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE photos SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
            (str(message)[:500], time.time(), photo_id),
        )


def delete_photos(photo_ids: Iterable[str]) -> int:
    ids = list(photo_ids)
    if not ids:
        return 0
    with connect() as conn:
        conn.executemany("DELETE FROM photos WHERE id = ?", [(photo_id,) for photo_id in ids])
    return len(ids)


def count_photos_by_status(status: str | None = None) -> int:
    with connect() as conn:
        if status is None:
            return conn.execute("SELECT COUNT(*) AS c FROM photos").fetchone()["c"]
        return conn.execute("SELECT COUNT(*) AS c FROM photos WHERE status = ?", (status,)).fetchone()["c"]

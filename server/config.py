from __future__ import annotations

import os
from dataclasses import dataclass


def resolve_db_path() -> str:
    configured = os.getenv("DB_PATH")
    if configured:
        return configured

    default_data_path = os.path.join("data", "ai_culling.db")
    legacy_path = "ai_culling.db"
    if os.path.exists(legacy_path) and not os.path.exists(default_data_path):
        return legacy_path
    return default_data_path


@dataclass(frozen=True)
class AppConfig:
    upload_folder: str = os.getenv("UPLOAD_FOLDER", "uploads")
    db_path: str = resolve_db_path()
    gc_interval_seconds: int = int(os.getenv("GC_INTERVAL_SECONDS", "300"))
    max_content_length: int = int(os.getenv("MAX_CONTENT_LENGTH", str(100 * 1024 * 1024)))
    score_workers: int = int(os.getenv("SCORE_WORKERS", "2"))


ALLOWED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}

from __future__ import annotations

import os
import platform
import shutil
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path


def resolve_db_path() -> str:
    configured = os.getenv("DB_PATH")
    if configured:
        return configured

    app_data_dir = os.getenv("AI_CULLING_APP_SUPPORT")
    if not app_data_dir:
        system = platform.system()
        if system == "Darwin":
            app_data_dir = str(Path.home() / "Library" / "Application Support" / "AI Photo Culling")
        elif system == "Windows":
            app_data_dir = os.path.join(os.getenv("APPDATA", str(Path.home())), "AI Photo Culling")
        else:
            app_data_dir = os.path.join(os.getenv("XDG_DATA_HOME", str(Path.home() / ".local" / "share")), "ai-photo-culling")
    return os.path.join(app_data_dir, "ai_culling.db")


def migrate_legacy_db(db_path: str, base_dir: str | os.PathLike[str] | None = None) -> str | None:
    if os.path.exists(db_path):
        return None

    root = Path(base_dir or os.getcwd())
    legacy_paths = [root / "data" / "ai_culling.db", root / "ai_culling.db"]
    legacy_path = next((path for path in legacy_paths if path.exists()), None)
    if legacy_path is None:
        return None

    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    shutil.move(str(legacy_path), db_path)
    return str(legacy_path)


def resolve_upload_folder() -> str:
    return os.getenv("UPLOAD_FOLDER", "uploads")


def resolve_render_cache_folder() -> str:
    configured = os.getenv("RAW_RENDER_CACHE")
    if configured:
        return configured
    return os.path.join(os.path.dirname(resolve_db_path()), "renders")


def resolve_gc_interval_seconds() -> int:
    return int(os.getenv("GC_INTERVAL_SECONDS", "300"))


def resolve_max_content_length() -> int:
    return int(os.getenv("MAX_CONTENT_LENGTH", str(100 * 1024 * 1024)))


def resolve_score_workers() -> int:
    return int(os.getenv("SCORE_WORKERS", "1"))


@dataclass(frozen=True)
class AppConfig:
    upload_folder: str = field(default_factory=resolve_upload_folder)
    render_cache_folder: str = field(default_factory=resolve_render_cache_folder)
    db_path: str = field(default_factory=resolve_db_path)
    gc_interval_seconds: int = field(default_factory=resolve_gc_interval_seconds)
    max_content_length: int = field(default_factory=resolve_max_content_length)
    score_workers: int = field(default_factory=resolve_score_workers)

    def __post_init__(self) -> None:
        if os.getenv("RAW_RENDER_CACHE"):
            return
        default_cache = resolve_render_cache_folder()
        if self.render_cache_folder == default_cache:
            object.__setattr__(self, "render_cache_folder", os.path.join(os.path.dirname(self.db_path), "renders"))


ALLOWED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".dng", ".heic", ".heif", ".hif"}

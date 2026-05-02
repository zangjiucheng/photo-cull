from __future__ import annotations

import hashlib
import importlib
import importlib.util
import io
import os
from typing import Any

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import AppConfig


RAW_EXTS = {".dng"}
MAX_DISPLAY_EDGE = 2400
JPEG_QUALITY = 90

_config = AppConfig()
_heif_registered = False


class InvalidRawImageError(ValueError):
    pass


def _register_heif_opener() -> None:
    global _heif_registered
    if _heif_registered:
        return
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
        _heif_registered = True
    except Exception:
        _heif_registered = False


_register_heif_opener()


def configure(config: AppConfig) -> None:
    global _config
    _config = config
    os.makedirs(_config.render_cache_folder, exist_ok=True)


def is_raw_image(path_or_name: str) -> bool:
    _root, ext = os.path.splitext(str(path_or_name).lower())
    return ext in RAW_EXTS


def _content_hash(path: str) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_rawpy():
    if importlib.util.find_spec("rawpy") is None:
        raise InvalidRawImageError("rawpy is not installed")
    return importlib.import_module("rawpy")


def _normalize_display_image(img: Image.Image, target_path: str, orientation_override: int | None = None) -> str:
    oriented = ImageOps.exif_transpose(img)
    if orientation_override:
        oriented = oriented.rotate(-orientation_override, expand=True)
    rgb = oriented.convert("RGB")
    rgb.thumbnail((MAX_DISPLAY_EDGE, MAX_DISPLAY_EDGE), Image.Resampling.LANCZOS)
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    rgb.save(target_path, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return target_path


def _exif_orientation(path: str) -> int | None:
    try:
        with Image.open(path) as img:
            orientation = img.getexif().get(274)
    except (UnidentifiedImageError, OSError):
        return None
    return int(orientation) if orientation in {2, 3, 4, 5, 6, 7, 8} else None


def _normalize_orientation_override(value: int | None) -> int | None:
    if value is None:
        return None
    normalized = int(value) % 360
    return normalized if normalized in {90, 180, 270} else None


def _ensure_oriented_raster(path: str, content_hash: str | None = None, orientation_override: int | None = None) -> str:
    _register_heif_opener()
    override = _normalize_orientation_override(orientation_override)
    if _exif_orientation(path) is None and override is None:
        return path

    cache_key = content_hash or _content_hash(path)
    suffix = f"-override-{override}" if override is not None else "-oriented"
    target_path = os.path.join(_config.render_cache_folder, f"{cache_key}{suffix}.jpg")
    if os.path.exists(target_path):
        return target_path

    try:
        with Image.open(path) as img:
            return _normalize_display_image(img, target_path, override)
    except (UnidentifiedImageError, OSError) as exc:
        raise InvalidRawImageError("File is not a valid image") from exc


def _image_from_raw_thumbnail(rawpy: Any, thumb: Any) -> Image.Image:
    if thumb.format == rawpy.ThumbFormat.JPEG:
        return Image.open(io.BytesIO(thumb.data))
    if thumb.format == rawpy.ThumbFormat.BITMAP:
        return Image.fromarray(np.asarray(thumb.data, dtype=np.uint8), "RGB")
    raise InvalidRawImageError("Unsupported RAW thumbnail format")


def _render_raw_to_jpeg(path: str, target_path: str, orientation_override: int | None = None) -> str:
    rawpy = _load_rawpy()
    try:
        with rawpy.imread(path) as raw:
            try:
                thumb = raw.extract_thumb()
                with _image_from_raw_thumbnail(rawpy, thumb) as img:
                    return _normalize_display_image(img, target_path, orientation_override)
            except Exception:
                rgb = raw.postprocess(output_bps=8, use_camera_wb=True)
                img = Image.fromarray(np.asarray(rgb, dtype=np.uint8), "RGB")
                return _normalize_display_image(img, target_path, orientation_override)
    except Exception as exc:
        raise InvalidRawImageError("File is not a valid DNG image") from exc


def load_full_raw_image(path: str, orientation_override: int | None = None) -> Image.Image:
    if not is_raw_image(path):
        raise InvalidRawImageError("File is not a RAW image")
    if not os.path.exists(path):
        raise InvalidRawImageError("RAW file does not exist")

    rawpy = _load_rawpy()
    override = _normalize_orientation_override(orientation_override)
    try:
        with rawpy.imread(path) as raw:
            rgb = raw.postprocess(output_bps=8, use_camera_wb=True)
        img = Image.fromarray(np.asarray(rgb, dtype=np.uint8), "RGB")
        if override:
            img = img.rotate(-override, expand=True)
        return img.convert("RGB")
    except Exception as exc:
        raise InvalidRawImageError("File is not a valid DNG image") from exc


def validate_raw_file(path: str) -> None:
    if not is_raw_image(path):
        return
    if not os.path.exists(path):
        raise InvalidRawImageError("RAW file does not exist")
    rawpy = _load_rawpy()
    try:
        with rawpy.imread(path):
            return
    except Exception as exc:
        raise InvalidRawImageError("File is not a valid DNG image") from exc


def ensure_display_image(path: str, content_hash: str | None = None, orientation_override: int | None = None) -> str:
    override = _normalize_orientation_override(orientation_override)
    if not is_raw_image(path):
        return _ensure_oriented_raster(path, content_hash, override)
    if not os.path.exists(path):
        raise InvalidRawImageError("RAW file does not exist")

    cache_key = content_hash or _content_hash(path)
    suffix = f"-override-{override}" if override is not None else ""
    target_path = os.path.join(_config.render_cache_folder, f"{cache_key}{suffix}.jpg")
    if os.path.exists(target_path):
        return target_path
    return _render_raw_to_jpeg(path, target_path, override)


def validate_image_file(path: str) -> None:
    _register_heif_opener()
    if is_raw_image(path):
        validate_raw_file(path)
        return

    try:
        with Image.open(path) as img:
            img.verify()
    except (UnidentifiedImageError, OSError) as exc:
        raise InvalidRawImageError("File is not a valid image") from exc


def display_path_for_row(row: Any) -> str:
    return ensure_display_image(row["path"], row["content_hash"], row["orientation_override"])


def delete_cached_renders(content_hashes: set[str] | list[str]) -> int:
    deleted = 0
    for content_hash in set(content_hashes):
        if not content_hash:
            continue
        for suffix in ("", "-oriented", "-override-90", "-override-180", "-override-270"):
            target_path = os.path.join(_config.render_cache_folder, f"{content_hash}{suffix}.jpg")
            try:
                os.remove(target_path)
                deleted += 1
            except FileNotFoundError:
                continue
    return deleted

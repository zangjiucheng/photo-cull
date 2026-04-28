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


class InvalidRawImageError(ValueError):
    pass


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


def _normalize_display_image(img: Image.Image, target_path: str) -> str:
    oriented = ImageOps.exif_transpose(img)
    rgb = oriented.convert("RGB")
    rgb.thumbnail((MAX_DISPLAY_EDGE, MAX_DISPLAY_EDGE), Image.Resampling.LANCZOS)
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    rgb.save(target_path, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return target_path


def _image_from_raw_thumbnail(rawpy: Any, thumb: Any) -> Image.Image:
    if thumb.format == rawpy.ThumbFormat.JPEG:
        return Image.open(io.BytesIO(thumb.data))
    if thumb.format == rawpy.ThumbFormat.BITMAP:
        return Image.fromarray(np.asarray(thumb.data, dtype=np.uint8), "RGB")
    raise InvalidRawImageError("Unsupported RAW thumbnail format")


def _render_raw_to_jpeg(path: str, target_path: str) -> str:
    rawpy = _load_rawpy()
    try:
        with rawpy.imread(path) as raw:
            try:
                thumb = raw.extract_thumb()
                with _image_from_raw_thumbnail(rawpy, thumb) as img:
                    return _normalize_display_image(img, target_path)
            except Exception:
                rgb = raw.postprocess(output_bps=8, use_camera_wb=True)
                img = Image.fromarray(np.asarray(rgb, dtype=np.uint8), "RGB")
                return _normalize_display_image(img, target_path)
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


def ensure_display_image(path: str, content_hash: str | None = None) -> str:
    if not is_raw_image(path):
        return path
    if not os.path.exists(path):
        raise InvalidRawImageError("RAW file does not exist")

    cache_key = content_hash or _content_hash(path)
    target_path = os.path.join(_config.render_cache_folder, f"{cache_key}.jpg")
    if os.path.exists(target_path):
        return target_path
    return _render_raw_to_jpeg(path, target_path)


def validate_image_file(path: str) -> None:
    if is_raw_image(path):
        validate_raw_file(path)
        return

    try:
        with Image.open(path) as img:
            img.verify()
    except (UnidentifiedImageError, OSError) as exc:
        raise InvalidRawImageError("File is not a valid image") from exc


def display_path_for_row(row: Any) -> str:
    return ensure_display_image(row["path"], row["content_hash"])

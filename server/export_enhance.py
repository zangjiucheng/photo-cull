from __future__ import annotations

import importlib
import math
from collections import OrderedDict
import base64
import io
import json
import os
import sys
import threading
import time
import traceback
import urllib.request
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor, Future
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps, ImageCms

from . import db, events, raw_pipeline, editing


# Legacy (v1) style ids plus every v2 preset in editing_presets.json.
STYLE_PRESETS = {"standard", "bright", "dramatic", "warm", "cool", "muted", "mono"} | set(editing.PRESETS)
UPSCALE_SCALES = {2, 4}
DENOISE_STRENGTHS = {"low", "medium", "high"}
REALESRGAN_SOURCE_BASE = "https://raw.githubusercontent.com/ai-forever/Real-ESRGAN/main/RealESRGAN"
REALESRGAN_SOURCE_FILES = ("__init__.py", "model.py", "rrdbnet_arch.py", "arch_utils.py", "utils.py")


class ExportEnhanceError(ValueError):
    pass


@dataclass
class PhotoStyle:
    preset: str = "standard"
    tone: float = 0.0
    colour: float = 0.0
    palette: float = 100.0


@dataclass
class EnhanceSettings:
    recipe_version: int = 2
    # Immutable v0.3.1 rendering contract. Missing fields in existing recipes resolve here.
    engine_version: int = 1
    raw_profile_version: int = 1
    exposure: float = 0.0
    brilliance: float = 0.0
    vibrance: float = 0.0
    black_point: float = 0.0
    dehaze: float = 0.0
    crop: dict[str, float] = field(default_factory=lambda: {"x": 0, "y": 0, "width": 1, "height": 1, "angle": 0})
    auto: dict[str, Any] | None = None
    # UI state for the Tone/Color pad; rendering only ever reads the slider values it produced.
    pad: dict[str, Any] | None = None
    gradient: dict[str, Any] | None = None
    selected_color: dict[str, float] | None = None
    contrast: float = 0.0
    highlights: float = 0.0
    shadows: float = 0.0
    saturation: float = 0.0
    temperature: float = 0.0
    tint: float = 0.0
    ai_denoise: bool = False
    ai_denoise_strength: str = "medium"
    upscale: bool = False
    upscale_scale: int = 2
    sharpen: float = 0.0
    output_format: str = "jpeg"
    quality: int = 92
    resize_max_edge: int | None = None
    photo_style: PhotoStyle = field(default_factory=PhotoStyle)


@dataclass
class ExportFailure:
    photo_id: str
    name: str
    error: str


@dataclass
class ExportJob:
    id: str
    selected_ids: list[str]
    output_folder: str
    settings: EnhanceSettings
    settings_by_photo: dict[str, EnhanceSettings] = field(default_factory=dict)
    workspace_id: str | None = None
    status: str = "queued"
    total: int = 0
    completed: int = 0
    failed: int = 0
    current: str | None = None
    outputs: list[str] = field(default_factory=list)
    failures: list[ExportFailure] = field(default_factory=list)
    processing_notes: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    cancel_requested: bool = False
    # photo_id -> "pending" | "done" | "failed", mirrored in export_job_items.
    item_status: dict[str, str] = field(default_factory=dict)


def _float_setting(settings: dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(settings.get(key, default))
    except (TypeError, ValueError):
        raise ExportEnhanceError(f"{key} must be a number")
    if not math.isfinite(value):
        raise ExportEnhanceError(f"{key} must be finite")
    return max(low, min(high, value))


def parse_settings(raw: dict[str, Any] | None) -> EnhanceSettings:
    try:
        return _parse_settings(raw)
    except ExportEnhanceError:
        raise
    except (TypeError, ValueError, OverflowError) as exc:
        raise ExportEnhanceError("Invalid numeric or structured editing setting") from exc


def _parse_settings(raw: dict[str, Any] | None) -> EnhanceSettings:
    settings = raw or {}
    if not isinstance(settings, dict):
        raise ExportEnhanceError("settings must be an object")
    if settings.get("recipeVersion", 1) not in {1, 2}:
        raise ExportEnhanceError("Unsupported recipeVersion")
    for key in ("engineVersion", "rawProfileVersion"):
        if type(settings.get(key, 1)) is not int or settings.get(key, 1) != 1:
            raise ExportEnhanceError(f"Unsupported {key}; update Photo Cull to open this edit")
    crop = settings.get("crop") or {}
    if not isinstance(crop, dict):
        raise ExportEnhanceError("crop must be an object")
    width = _float_setting(crop, "width", 1, .05, 1)
    height = _float_setting(crop, "height", 1, .05, 1)
    parsed_crop = {"width": width, "height": height,
                   "x": _float_setting(crop, "x", 0, 0, 1 - width),
                   "y": _float_setting(crop, "y", 0, 0, 1 - height),
                   "angle": _float_setting(crop, "angle", 0, -15, 15)}
    auto = settings.get("auto")
    if auto is not None:
        if not isinstance(auto, dict) or not isinstance(auto.get("base"), dict) or not isinstance(auto.get("target"), dict):
            raise ExportEnhanceError("auto must contain base and target controls")
        keys = ("exposure", "brilliance", "highlights", "shadows", "vibrance", "temperature")
        auto = {"strength": _float_setting(auto, "strength", 1, 0, 1),
                **{group: {key: _float_setting(auto[group], key, 0, -3 if key == "exposure" else -1, 3 if key == "exposure" else 1)
                           for key in keys} for group in ("base", "target")}}
    pad = settings.get("pad")
    if pad is not None:
        vectors = pad.get("vectors") if isinstance(pad, dict) else None
        if not isinstance(pad, dict) or not isinstance(pad.get("base"), dict) or not isinstance(vectors, dict):
            raise ExportEnhanceError("pad must contain base controls and vectors")
        def directions(axis):
            raw = vectors.get(axis) if isinstance(vectors.get(axis), dict) else {}
            return {side: {key: _float_setting(raw.get(side) or {}, key, 0, -1, 1) for key in editing.PAD_KEYS}
                    for side in ("up", "down")}
        pad = {"tone": _float_setting(pad, "tone", 0, -1, 1), "colour": _float_setting(pad, "colour", 0, -1, 1),
               "base": {key: _float_setting(pad["base"], key, 0, -1, 1) for key in editing.PAD_KEYS},
               "vectors": {"tone": directions("tone"), "colour": directions("colour")}}
    style_raw = settings.get("photoStyle", settings.get("photo_style", {}))
    gradient = settings.get("gradient")
    selected_color = settings.get("selectedColor")
    if selected_color is not None:
        if not isinstance(selected_color, dict):
            raise ExportEnhanceError("selectedColor must be an object")
        selected_color = {"center": _float_setting(selected_color, "center", 2 / 3, 0, 1),
                          "range": _float_setting(selected_color, "range", .12, .02, .5),
                          **{key: _float_setting(selected_color, key, 0, -1, 1) for key in ("hue", "saturation", "luminance")}}
    if gradient is not None:
        if not isinstance(gradient, dict):
            raise ExportEnhanceError("gradient must be an object")
        points = {}
        for name, default_y in (("start", .15), ("end", .65)):
            point = gradient.get(name, {"x": .5, "y": default_y})
            if not isinstance(point, dict):
                raise ExportEnhanceError(f"gradient.{name} must be a point")
            points[name] = {axis: _float_setting(point, axis, .5 if axis == "x" else default_y, 0, 1) for axis in ("x", "y")}
        if sum((points["start"][axis] - points["end"][axis]) ** 2 for axis in ("x", "y")) < 1e-6:
            raise ExportEnhanceError("Gradient endpoints must be separated")
        gradient = {**points, "enabled": gradient.get("enabled", True) is True, "invert": gradient.get("invert", False) is True,
                    "feather": _float_setting(gradient, "feather", 1, .05, 1),
                    **{key: _float_setting(gradient, key, 0, -2 if key == "exposure" else -1, 2 if key == "exposure" else 1)
                       for key in ("exposure", "highlights", "temperature")}}
    style_raw = style_raw if isinstance(style_raw, dict) else {}
    preset = str(style_raw.get("preset", "standard")).lower()
    if preset not in STYLE_PRESETS:
        preset = "standard"
    output_format = str(settings.get("outputFormat", settings.get("output_format", "jpeg"))).lower()
    if output_format not in {"jpeg", "tiff"}:
        raise ExportEnhanceError("outputFormat must be jpeg or tiff")
    quality = int(settings.get("quality", 92))
    if quality < 1 or quality > 100:
        raise ExportEnhanceError("quality must be between 1 and 100")
    resize = settings.get("resizeMaxEdge", settings.get("resize_max_edge"))
    resize_max_edge = None
    if resize not in {None, "", 0}:
        resize_max_edge = int(resize)
        if resize_max_edge < 256:
            raise ExportEnhanceError("resizeMaxEdge must be at least 256")
    try:
        upscale_scale = int(settings.get("upscaleScale", settings.get("upscale_scale", 2)))
    except (TypeError, ValueError):
        raise ExportEnhanceError("upscaleScale must be 2 or 4")
    if upscale_scale not in UPSCALE_SCALES:
        raise ExportEnhanceError("upscaleScale must be 2 or 4")
    denoise_strength = str(settings.get("aiDenoiseStrength", settings.get("ai_denoise_strength", "medium"))).lower()
    if denoise_strength not in DENOISE_STRENGTHS:
        raise ExportEnhanceError("aiDenoiseStrength must be low, medium, or high")
    return EnhanceSettings(
        recipe_version=2 if settings.get("recipeVersion") == 2 else 1,
        exposure=_float_setting(settings, "exposure", 0.0, -3.0, 3.0),
        brilliance=_float_setting(settings, "brilliance", 0.0, -1.0, 1.0),
        vibrance=_float_setting(settings, "vibrance", 0.0, -1.0, 1.0),
        black_point=_float_setting(settings, "blackPoint", 0.0, -1.0, 1.0),
        dehaze=_float_setting(settings, "dehaze", 0.0, -1.0, 1.0),
        crop=parsed_crop,
        auto=auto,
        pad=pad,
        gradient=gradient,
        selected_color=selected_color,
        contrast=_float_setting(settings, "contrast", 0.0, -1.0, 1.0),
        highlights=_float_setting(settings, "highlights", 0.0, -1.0, 1.0),
        shadows=_float_setting(settings, "shadows", 0.0, -1.0, 1.0),
        saturation=_float_setting(settings, "saturation", 0.0, -1.0, 1.0),
        temperature=_float_setting(settings, "temperature", 0.0, -1.0, 1.0),
        tint=_float_setting(settings, "tint", 0.0, -1.0, 1.0),
        ai_denoise=bool(settings.get("aiDenoise", settings.get("ai_denoise", False))),
        ai_denoise_strength=denoise_strength,
        upscale=bool(settings.get("upscale", False)),
        upscale_scale=upscale_scale,
        sharpen=_float_setting(settings, "sharpen", 0.0, 0.0, 1.0),
        output_format=output_format,
        quality=quality,
        resize_max_edge=resize_max_edge,
        photo_style=PhotoStyle(
            preset=preset,
            tone=_float_setting(style_raw, "tone", 0.0, -100.0, 100.0),
            colour=_float_setting(style_raw, "colour", 0.0, -100.0, 100.0),
            palette=_float_setting(style_raw, "palette", 100.0, 0.0, 100.0),
        ),
    )


def serialize_settings(settings: EnhanceSettings) -> dict[str, Any]:
    return {
        "recipeVersion": settings.recipe_version,
        "engineVersion": settings.engine_version,
        "rawProfileVersion": settings.raw_profile_version,
        "exposure": settings.exposure,
        "brilliance": settings.brilliance,
        "vibrance": settings.vibrance,
        "blackPoint": settings.black_point,
        "dehaze": settings.dehaze,
        "crop": settings.crop,
        "auto": settings.auto,
        "pad": settings.pad,
        "gradient": settings.gradient,
        "selectedColor": settings.selected_color,
        "contrast": settings.contrast,
        "highlights": settings.highlights,
        "shadows": settings.shadows,
        "saturation": settings.saturation,
        "temperature": settings.temperature,
        "tint": settings.tint,
        "aiDenoise": settings.ai_denoise,
        "aiDenoiseStrength": settings.ai_denoise_strength,
        "upscale": settings.upscale,
        "upscaleScale": settings.upscale_scale,
        "sharpen": settings.sharpen,
        "outputFormat": settings.output_format,
        "quality": settings.quality,
        "resizeMaxEdge": settings.resize_max_edge,
        "photoStyle": {
            "preset": settings.photo_style.preset,
            "tone": settings.photo_style.tone,
            "colour": settings.photo_style.colour,
            "palette": settings.photo_style.palette,
        },
    }


class CacheBudget:
    """One resident-image budget shared by editor and export caches (not working buffers)."""
    def __init__(self, max_bytes=384 * 1024 ** 2):
        self.max_bytes = max_bytes
        self.lock = threading.RLock()
        self.loaders = []
        self.sequence = 0

    def trim(self):
        entries = [(loader, cache, key, value[0].nbytes if cache is loader._cache else value.nbytes)
                   for loader in self.loaders for cache in (loader._cache, loader._scaled)
                   for key, value in cache.items()]
        total = sum(entry[3] for entry in entries)
        # A single 48MP base can exceed the budget. Keep it usable, but retain no other images.
        latest_full = max((entry for entry in entries if entry[1] is entry[0]._cache),
                          key=lambda entry: entry[0]._used.get((id(entry[1]), entry[2]), 0), default=None)
        oversized = latest_full if latest_full is not None and latest_full[3] > self.max_bytes else None
        candidates = [entry for entry in entries if entry is not oversized]
        candidates.sort(key=lambda entry: entry[0]._used.get((id(entry[1]), entry[2]), 0))
        for loader, cache, key, size in candidates:
            if total <= self.max_bytes:
                break
            cache.pop(key, None)
            loader._used.pop((id(cache), key), None)
            total -= size


class ImageLoader:
    """Full-resolution decode cache plus a cache of downscaled copies for the editor.

    Decoding happens outside the lock: concurrent requests for the same photo share one in-flight
    decode, and requests for other (cached) photos are never blocked behind it.
    """

    def __init__(self, capacity: int = 2, scaled_capacity: int = 8, budget: CacheBudget | None = None):
        self._cache = OrderedDict()
        self._scaled = OrderedDict()
        self._inflight: dict[tuple, Future] = {}
        self._capacity = capacity
        self._scaled_capacity = scaled_capacity
        self._budget = budget or CacheBudget()
        self._lock = self._budget.lock
        self._budget.loaders.append(self)
        self._used = {}
        self._dimensions = OrderedDict()

    def source_size(self, row):
        key = self._key(row)
        with self._lock:
            if key in self._dimensions:
                self._dimensions.move_to_end(key)
                return self._dimensions[key]
        image = self.load(row)[0]
        return image.shape[1], image.shape[0]

    def _touch(self, cache, key):
        cache.move_to_end(key)
        # Accesses can share one timer tick on Windows/Python 3.11. A shared sequence
        # gives a strict order across both loaders while holding the budget lock.
        self._budget.sequence += 1
        self._used[(id(cache), key)] = self._budget.sequence

    def _limit(self, cache, capacity):
        while len(cache) > capacity:
            key, _ = cache.popitem(last=False)
            self._used.pop((id(cache), key), None)
        self._budget.trim()

    @staticmethod
    def _key(row: Any) -> tuple:
        source_path = row["path"]
        stat = os.stat(source_path)
        return (source_path, stat.st_mtime_ns, stat.st_size, row["orientation_override"])

    def load_scaled(self, row: Any, max_edge: int) -> np.ndarray:
        """The full decode resized to max_edge; identical to resize_float(load(row)[0], max_edge)."""
        key = (*self._key(row), max_edge)
        with self._lock:
            if key in self._scaled:
                self._touch(self._scaled, key)
                return self._scaled[key]
        scaled = editing.resize_float(self.load(row)[0], max_edge)
        with self._lock:
            self._scaled[key] = scaled
            self._touch(self._scaled, key)
            self._limit(self._scaled, self._scaled_capacity)
        return scaled

    def load(self, row: Any, *, full_raw: bool = True) -> tuple[np.ndarray, bytes | None, str]:
        # The flag remains accepted for callers from older integrations. Editing
        # always starts with the full source, never an embedded browsing JPEG.
        key = self._key(row)
        with self._lock:
            if key in self._cache:
                self._touch(self._cache, key)
                return self._cache[key]
            pending = self._inflight.get(key)
            owner = pending is None
            if owner:
                pending = self._inflight[key] = Future()
        if not owner:
            return pending.result()
        try:
            result = self._decode(row)
        except BaseException as exc:
            with self._lock:
                self._inflight.pop(key, None)
            pending.set_exception(exc)
            raise
        with self._lock:
            self._inflight.pop(key, None)
            self._cache[key] = result
            self._dimensions[key] = (result[0].shape[1], result[0].shape[0])
            self._dimensions.move_to_end(key)
            while len(self._dimensions) > 64:
                self._dimensions.popitem(last=False)
            self._touch(self._cache, key)
            self._limit(self._cache, self._capacity)
        pending.set_result(result)
        return result

    def _decode(self, row: Any) -> tuple[np.ndarray, bytes | None, str]:
        source_path = row["path"]
        exif = None
        try:
            with Image.open(source_path) as source:
                exif = source.getexif().tobytes()
        except Exception:
            exif = None
        if raw_pipeline.is_raw_image(source_path):
            linear = raw_pipeline.load_full_raw_array(source_path, row["orientation_override"])
            curve = raw_pipeline.profile_tone_curve(source_path)
            if curve is not None:
                linear = editing.apply_profile_tone(linear * 2 ** editing.BASE_EXPOSURE_EV, curve)
            return editing.encode_srgb(linear), exif, source_path

        with Image.open(source_path) as image:
            oriented = ImageOps.exif_transpose(image)
            profile = image.info.get("icc_profile")
            if source_path.lower().endswith((".tif", ".tiff")):
                import tifffile
                with tifffile.TiffFile(source_path) as tif:
                    data = tif.pages[0].asarray()
                if data.dtype == np.uint16 and data.ndim == 3 and data.shape[2] == 3:
                    if profile and profile[128:] != editing.SRGB_ICC[128:]:
                        raise ExportEnhanceError("16-bit TIFF editing requires an untagged sRGB TIFF or a Photo Cull sRGB TIFF. Use the original RAW for other profiles.")
                    arr = editing.orient_array(data.astype(np.float32) / 65535, image.getexif().get(274, 1))
                    if row["orientation_override"]:
                        arr = np.rot90(arr, -(row["orientation_override"] // 90))
                    return np.ascontiguousarray(arr), exif, source_path
            if profile:
                rgb = ImageCms.profileToProfile(oriented, ImageCms.ImageCmsProfile(io.BytesIO(profile)), ImageCms.createProfile("sRGB"), outputMode="RGB")
            else:
                rgb = oriented.convert("RGB")
            if row["orientation_override"]:
                rgb = rgb.rotate(-row["orientation_override"], expand=True)
            arr = np.asarray(rgb, dtype=np.float32) / 255.0
        return arr, exif, source_path

    def load_legacy(self, row: Any):
        if raw_pipeline.is_raw_image(row["path"]):
            rgb = raw_pipeline.load_full_raw_image(row["path"], row["orientation_override"])
            return np.asarray(rgb, dtype=np.float32) / 255, None, row["path"]
        with Image.open(row["path"]) as source:
            exif = source.info.get("exif")
        with Image.open(raw_pipeline.display_path_for_row(row)) as image:
            rgb = ImageOps.exif_transpose(image).convert("RGB")
            return np.asarray(rgb, dtype=np.float32) / 255, exif, row["path"]


class ColorProcessor:
    def apply(self, image: np.ndarray, settings: EnhanceSettings) -> np.ndarray:
        if settings.recipe_version >= 2:
            return editing.apply_color(image, settings)
        out = np.clip(image.astype(np.float32), 0.0, 1.0)
        out = np.clip(out * (2.0 ** settings.exposure), 0.0, 1.0)
        if settings.contrast:
            factor = 1.0 + settings.contrast
            out = np.clip((out - 0.5) * factor + 0.5, 0.0, 1.0)
        if settings.highlights:
            mask = np.clip((out - 0.5) * 2.0, 0.0, 1.0)
            out = np.clip(out + mask * settings.highlights * 0.25, 0.0, 1.0)
        if settings.shadows:
            mask = np.clip((0.5 - out) * 2.0, 0.0, 1.0)
            out = np.clip(out + mask * settings.shadows * 0.25, 0.0, 1.0)
        if settings.temperature or settings.tint:
            out = out.copy()
            out[..., 0] *= 1.0 + settings.temperature * 0.12
            out[..., 2] *= 1.0 - settings.temperature * 0.12
            out[..., 1] *= 1.0 + settings.tint * 0.10
            out = np.clip(out, 0.0, 1.0)
        if settings.saturation:
            gray = out @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
            out = np.clip(gray[..., None] + (out - gray[..., None]) * (1.0 + settings.saturation), 0.0, 1.0)
        return out.astype(np.float32)


@dataclass(frozen=True)
class StylePreset:
    matrix: tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]
    saturation: float
    vibrance: float
    warmth: float
    contrast: float
    shadow_tint: tuple[float, float, float]
    highlight_tint: tuple[float, float, float]


STYLE_PRESET_REGISTRY: dict[str, StylePreset] = {
    "standard": StylePreset(((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)), 0.0, 0.0, 0.0, 0.0, (0.00, 0.00, 0.00), (0.00, 0.00, 0.00)),
    "bright": StylePreset(((1.04, -0.01, -0.01), (-0.01, 1.03, -0.01), (-0.01, -0.01, 1.02)), 0.08, 0.10, 0.03, 0.06, (-0.01, 0.00, 0.02), (0.03, 0.02, -0.01)),
    "dramatic": StylePreset(((1.10, -0.04, -0.02), (-0.03, 1.06, -0.02), (-0.02, -0.03, 1.12)), 0.05, 0.04, -0.02, 0.22, (-0.03, -0.01, 0.04), (0.04, 0.02, -0.02)),
    "warm": StylePreset(((1.08, 0.01, -0.02), (0.00, 1.02, 0.00), (-0.03, 0.00, 0.98)), 0.07, 0.08, 0.12, 0.07, (0.00, 0.00, 0.02), (0.05, 0.02, -0.03)),
    "cool": StylePreset(((0.98, 0.00, -0.02), (0.00, 1.03, 0.00), (-0.02, 0.01, 1.09)), 0.04, 0.06, -0.12, 0.08, (-0.03, -0.01, 0.05), (0.01, 0.01, 0.02)),
    "muted": StylePreset(((1.02, 0.01, 0.00), (0.01, 1.02, 0.00), (0.00, 0.00, 1.02)), -0.16, -0.08, 0.02, -0.04, (0.01, 0.01, 0.02), (0.03, 0.02, 0.00)),
}


def _smoothstep(edge0: float, edge1: float, value: np.ndarray) -> np.ndarray:
    t = np.clip((value - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


class SemanticMaskProvider:
    def __init__(self, loader: ImageLoader | None = None):
        self._loader = loader or ImageLoader(capacity=1)
        self._cache: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self._lock = threading.Lock()
        self._torch_plugin_checked = False
        self._torch_plugin: Any | None = None

    def masks_for_row(self, row: Any, image: np.ndarray | None = None, max_edge: int | None = None) -> np.ndarray:
        source = str(row["path"])
        if image is None:
            # Check the cache before paying for a full RAW decode.
            stat = os.stat(source)
            request_key = (source, stat.st_mtime_ns, row["orientation_override"], max_edge or 0)
            with self._lock:
                cached = self._cache.get(request_key)
            if cached is not None:
                return cached.copy()
            image, _exif, _source = self._loader.load(row)
            masks = self.masks_for_row(row, image=image, max_edge=max_edge)
            with self._lock:
                self._remember(request_key, masks)
            return masks
        if max_edge and max(image.shape[:2]) > max_edge:
            pil = Image.fromarray((image * 255.0 + 0.5).astype(np.uint8), "RGB")
            pil.thumbnail((max_edge, max_edge), Image.Resampling.BILINEAR)
            image = np.asarray(pil, dtype=np.float32) / 255.0
        height, width = image.shape[:2]
        cache_key = (source, max_edge or 0, height, width)
        with self._lock:
            cached = self._cache.get(cache_key)
        if cached is not None:
            return cached.copy()
        masks = self._build_masks(image)
        with self._lock:
            self._remember(cache_key, masks)
        return masks

    def _remember(self, key: tuple, masks: np.ndarray) -> None:
        self._cache[key] = masks.copy()
        self._cache.move_to_end(key)
        while len(self._cache) > 16:
            self._cache.popitem(last=False)

    def _build_masks(self, image: np.ndarray) -> np.ndarray:
        skin = self._skin_mask(image)
        person = self._person_mask_plugin(image)
        if person is not None:
            skin = np.clip(np.maximum(skin, person * skin.max(initial=0.0)), 0.0, 1.0)
        sky = self._sky_mask(image, skin)
        foliage = self._foliage_mask(image, skin, sky)
        background = np.clip(1.0 - np.maximum.reduce([skin, sky, foliage]), 0.0, 1.0)
        return np.stack([skin, sky, foliage, background], axis=-1).astype(np.float32)

    def _person_mask_plugin(self, image: np.ndarray) -> np.ndarray | None:
        # Optional extension point: if a local AI Runtime plugin exposes segment_person(image),
        # use it. V1 remains shippable with heuristic masks when the plugin is absent.
        if not self._torch_plugin_checked:
            self._torch_plugin_checked = True
            try:
                self._torch_plugin = importlib.import_module("ai_culling_segmentation")
            except Exception:
                self._torch_plugin = None
        if self._torch_plugin is None or not hasattr(self._torch_plugin, "segment_person"):
            return None
        try:
            mask = self._torch_plugin.segment_person(image)
            arr = np.asarray(mask, dtype=np.float32)
            if arr.shape != image.shape[:2]:
                pil = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "L")
                pil = pil.resize((image.shape[1], image.shape[0]), Image.Resampling.BILINEAR)
                arr = np.asarray(pil, dtype=np.float32) / 255.0
            return np.clip(arr, 0.0, 1.0)
        except Exception:
            return None

    def _skin_mask(self, image: np.ndarray) -> np.ndarray:
        r, g, b = image[..., 0], image[..., 1], image[..., 2]
        y = 0.299 * r + 0.587 * g + 0.114 * b
        cb = (b - y) * 0.564 + 0.5
        cr = (r - y) * 0.713 + 0.5
        cb_score = 1.0 - np.clip(np.abs(cb - 0.42) / 0.13, 0.0, 1.0)
        cr_score = 1.0 - np.clip(np.abs(cr - 0.60) / 0.16, 0.0, 1.0)
        warm_score = np.clip((r - b + 0.12) / 0.32, 0.0, 1.0)
        bright_score = _smoothstep(0.12, 0.88, y)
        return np.clip(cb_score * cr_score * warm_score * bright_score, 0.0, 1.0).astype(np.float32)

    def _sky_mask(self, image: np.ndarray, skin: np.ndarray) -> np.ndarray:
        r, g, b = image[..., 0], image[..., 1], image[..., 2]
        y = 0.2126 * r + 0.7152 * g + 0.0722 * b
        blue_bias = np.clip((b - np.maximum(r, g) + 0.12) / 0.35, 0.0, 1.0)
        bright = _smoothstep(0.28, 0.88, y)
        return np.clip(blue_bias * bright * (1.0 - skin), 0.0, 1.0).astype(np.float32)

    def _foliage_mask(self, image: np.ndarray, skin: np.ndarray, sky: np.ndarray) -> np.ndarray:
        r, g, b = image[..., 0], image[..., 1], image[..., 2]
        green_bias = np.clip((g - np.maximum(r, b) + 0.08) / 0.30, 0.0, 1.0)
        saturation = np.max(image, axis=-1) - np.min(image, axis=-1)
        return np.clip(green_bias * _smoothstep(0.05, 0.35, saturation) * (1.0 - np.maximum(skin, sky)), 0.0, 1.0).astype(np.float32)

    def masks_data_url_for_row(self, row: Any, max_edge: int = 1024) -> dict[str, Any]:
        masks = self.masks_for_row(row, max_edge=max_edge)
        packed = (np.clip(masks, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        image = Image.fromarray(packed, "RGBA")
        buffer = io.BytesIO()
        image.save(buffer, "PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return {
            "photoId": row["id"],
            "width": image.width,
            "height": image.height,
            "dataUrl": f"data:image/png;base64,{encoded}",
        }


class PhotographicStyleProcessor:
    def __init__(self, masks: SemanticMaskProvider | None = None):
        self._masks = masks or SemanticMaskProvider()

    def apply(self, image: np.ndarray, settings: EnhanceSettings, row: Any | None = None) -> np.ndarray:
        if settings.recipe_version >= 2:
            return editing.apply_style(image, settings.photo_style)
        style = settings.photo_style
        original = np.clip(image.astype(np.float32), 0.0, 1.0)
        if style.palette <= 0:
            return original
        masks = self._masks.masks_for_row(row, original) if row is not None else self._masks._build_masks(original)
        styled = self._apply_style(original, style, masks)
        alpha = np.clip(style.palette / 100.0, 0.0, 1.0)
        return np.clip(original * (1.0 - alpha) + styled * alpha, 0.0, 1.0).astype(np.float32)

    def _apply_style(self, original: np.ndarray, style: PhotoStyle, masks: np.ndarray) -> np.ndarray:
        preset = STYLE_PRESET_REGISTRY.get(style.preset, STYLE_PRESET_REGISTRY["standard"])
        out = np.clip(original @ np.asarray(preset.matrix, dtype=np.float32).T, 0.0, 1.0)
        y = out @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        tone = np.clip(style.tone / 100.0, -1.0, 1.0)
        colour = np.clip(style.colour / 100.0, -1.0, 1.0)
        contrast = 1.0 + preset.contrast + max(tone, 0.0) * 0.32 + min(tone, 0.0) * 0.18
        out = np.clip((out - 0.5) * contrast + 0.5, 0.0, 1.0)
        shadow = 1.0 - _smoothstep(0.0, 0.42, y)
        midtone = _smoothstep(0.20, 0.50, y) * (1.0 - _smoothstep(0.55, 0.86, y))
        highlight = _smoothstep(0.58, 1.0, y)
        if tone > 0:
            out = np.clip(out - highlight[..., None] * tone * 0.08 + midtone[..., None] * tone * 0.04, 0.0, 1.0)
        elif tone < 0:
            out = np.clip(out + shadow[..., None] * (-tone) * 0.12 - midtone[..., None] * (-tone) * 0.03, 0.0, 1.0)
        out = self._adjust_saturation(out, 1.0 + preset.saturation + colour * 0.24)
        out = self._adjust_vibrance(out, preset.vibrance + abs(colour) * 0.12)
        warmth = preset.warmth + colour * 0.12
        out = np.clip(out + np.array([0.08, 0.025, -0.07], dtype=np.float32) * warmth, 0.0, 1.0)
        out = np.clip(out + shadow[..., None] * np.asarray(preset.shadow_tint, dtype=np.float32), 0.0, 1.0)
        out = np.clip(out + highlight[..., None] * np.asarray(preset.highlight_tint, dtype=np.float32), 0.0, 1.0)
        skin, sky, foliage = masks[..., 0], masks[..., 1], masks[..., 2]
        out = np.clip(out + sky[..., None] * np.array([-0.025, 0.01, 0.07], dtype=np.float32), 0.0, 1.0)
        out = np.clip(out + foliage[..., None] * np.array([-0.015, 0.055, -0.015], dtype=np.float32), 0.0, 1.0)
        skin_safe = self._adjust_saturation(out, max(0.72, 1.0 + preset.saturation * 0.25 + colour * 0.08))
        out = out * (1.0 - skin[..., None] * 0.35) + skin_safe * (skin[..., None] * 0.35)
        out = out * (1.0 - skin[..., None] * 0.50) + original * (skin[..., None] * 0.50)
        return np.clip(out, 0.0, 1.0).astype(np.float32)

    def _adjust_saturation(self, image: np.ndarray, factor: float) -> np.ndarray:
        gray = image @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        return np.clip(gray[..., None] + (image - gray[..., None]) * factor, 0.0, 1.0)

    def _adjust_vibrance(self, image: np.ndarray, amount: float) -> np.ndarray:
        maxc = np.max(image, axis=-1)
        minc = np.min(image, axis=-1)
        sat = maxc - minc
        factor = 1.0 + amount * (1.0 - np.clip(sat * 1.4, 0.0, 1.0))
        gray = image @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        return np.clip(gray[..., None] + (image - gray[..., None]) * factor[..., None], 0.0, 1.0)


class RealESRGANEngine:
    def __init__(self, model_dir: str | None = None):
        self._model_dir_override = model_dir
        self._models: dict[int, Any] = {}

    @property
    def model_dir(self) -> Path:
        base = self._model_dir_override or os.getenv("AI_RUNTIME_MODEL_DIR") or os.path.join(os.path.dirname(db.get_config().db_path), "ai-runtime", "models")
        return Path(base) / "real-esrgan"

    @property
    def source_dir(self) -> Path:
        return self.model_dir / "source"

    def _device(self):
        import torch

        if torch.cuda.is_available():
            return torch.device("cuda")
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")

    def _load_model(self, scale: int):
        if scale in self._models:
            return self._models[scale]
        if importlib.util.find_spec("torch") is None:
            raise ExportEnhanceError("AI Runtime with PyTorch is required for Real-ESRGAN Upscale.")
        if importlib.util.find_spec("cv2") is None or importlib.util.find_spec("huggingface_hub") is None:
            raise ExportEnhanceError("AI Runtime is missing Real-ESRGAN dependencies. Reinstall AI Runtime.")
        self._ensure_source()
        self._patch_huggingface_cache_download()
        source_root = str(self.source_dir)
        if source_root not in sys.path:
            sys.path.insert(0, source_root)
        from RealESRGAN import RealESRGAN

        self.model_dir.mkdir(parents=True, exist_ok=True)
        weight_path = self.model_dir / f"RealESRGAN_x{scale}.pth"
        model = RealESRGAN(self._device(), scale=scale)
        model.load_weights(str(weight_path), download=True)
        self._models[scale] = model
        return model

    def _ensure_source(self) -> None:
        package_dir = self.source_dir / "RealESRGAN"
        package_dir.mkdir(parents=True, exist_ok=True)
        for filename in REALESRGAN_SOURCE_FILES:
            target = package_dir / filename
            if target.exists() and target.stat().st_size > 0:
                continue
            urllib.request.urlretrieve(f"{REALESRGAN_SOURCE_BASE}/{filename}", target)

    def _patch_huggingface_cache_download(self) -> None:
        import huggingface_hub

        if hasattr(huggingface_hub, "cached_download"):
            return

        def cached_download(url, cache_dir=None, force_filename=None, **_kwargs):
            target_dir = Path(cache_dir or self.model_dir)
            target_dir.mkdir(parents=True, exist_ok=True)
            filename = force_filename or Path(str(url).split("?")[0]).name
            target = target_dir / filename
            if not target.exists() or target.stat().st_size == 0:
                urllib.request.urlretrieve(url, target)
            return str(target)

        huggingface_hub.cached_download = cached_download

    def apply(self, image: np.ndarray, scale: int) -> np.ndarray:
        model = self._load_model(scale)
        pil = Image.fromarray((np.clip(image, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGB")
        out = model.predict(pil)
        return (np.asarray(out.convert("RGB"), dtype=np.float32) / 255.0).astype(np.float32)


class AIDenoiseEngine:
    _strength: dict[str, tuple[float, float]] = {
        "low": (3.0, 0.35),
        "medium": (6.0, 0.55),
        "high": (10.0, 0.75),
    }

    def apply(self, image: np.ndarray, strength: str) -> np.ndarray:
        return self.apply_with_info(image, strength)[0]

    def apply_with_info(self, image: np.ndarray, strength: str) -> tuple[np.ndarray, str]:
        h, blend = self._strength.get(strength, self._strength["medium"])
        source = np.clip(image.astype(np.float32), 0.0, 1.0)
        uint = (source * 255.0 + 0.5).astype(np.uint8)
        denoised = self._opencv_denoise(uint, h)
        engine = "OpenCV non-local means"
        if denoised is None:
            denoised = self._pil_denoise(uint, strength)
            engine = "Pillow smoothing (OpenCV unavailable)"
        restored = np.asarray(denoised, dtype=np.float32) / 255.0
        return np.clip(source * (1.0 - blend) + restored * blend, 0.0, 1.0).astype(np.float32), engine

    def _opencv_denoise(self, uint: np.ndarray, h: float) -> np.ndarray | None:
        try:
            import cv2

            bgr = cv2.cvtColor(uint, cv2.COLOR_RGB2BGR)
            out = cv2.fastNlMeansDenoisingColored(bgr, None, h, h, 7, 21)
            return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
        except Exception:
            return None

    def _pil_denoise(self, uint: np.ndarray, strength: str) -> np.ndarray:
        pil = Image.fromarray(uint, "RGB")
        if strength == "high":
            pil = pil.filter(ImageFilter.MedianFilter(size=3)).filter(ImageFilter.SMOOTH_MORE)
        elif strength == "medium":
            pil = pil.filter(ImageFilter.MedianFilter(size=3)).filter(ImageFilter.SMOOTH)
        else:
            pil = pil.filter(ImageFilter.SMOOTH)
        return np.asarray(pil.convert("RGB"), dtype=np.uint8)


class ExportWriter:
    def write(self, image: np.ndarray, row: Any, output_folder: str, settings: EnhanceSettings, exif: bytes | None) -> str:
        os.makedirs(output_folder, exist_ok=True)
        stem = Path(row["name"]).stem or row["id"]
        suffix = ".jpg" if settings.output_format == "jpeg" else ".tif"
        output_path = Path(output_folder) / f"{stem}_enhanced{suffix}"
        counter = 2
        while output_path.exists():
            output_path = Path(output_folder) / f"{stem}_enhanced_{counter}{suffix}"
            counter += 1

        # Write next to the target and rename when complete, so an interrupted export never leaves
        # a truncated file under the final name.
        final_path, output_path = output_path, output_path.with_name(output_path.name + ".partial")
        out = np.clip(image, 0.0, 1.0)
        if settings.resize_max_edge:
            out = editing.resize_float(out, settings.resize_max_edge)
        out = editing.sharpen_float(out, settings.sharpen)
        safe_exif = editing.clean_exif(exif, out.shape[1], out.shape[0])

        if settings.output_format == "jpeg":
            pil = Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), "RGB")
            save_kwargs = {"quality": settings.quality, "subsampling": 0, "optimize": True,
                           "icc_profile": editing.SRGB_ICC, "exif": safe_exif.tobytes()}
            try:
                pil.save(output_path, "JPEG", **save_kwargs)
            except BaseException:
                output_path.unlink(missing_ok=True)
                raise
        else:
            arr16 = (out * 65535.0 + 0.5).astype(np.uint16)
            import tifffile

            tags = [(34675, "B", len(editing.SRGB_ICC), editing.SRGB_ICC, False), (274, "H", 1, 1, False),
                    (34664, "I", 1, 0, False)]
            for tag in (271, 272, 306, 315, 33432):
                if tag in safe_exif:
                    tags.append((tag, "s", 0, str(safe_exif[tag]), False))
            try:
                tifffile.imwrite(output_path, arr16, photometric="rgb", metadata=None, extratags=tags, software="Photo Cull")
                editing.attach_tiff_capture(output_path, safe_exif)
            except BaseException:
                output_path.unlink(missing_ok=True)
                raise
        os.replace(output_path, final_path)
        return str(final_path)


class JobQueue:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, ExportJob] = {}
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._prefetcher = ThreadPoolExecutor(max_workers=1, thread_name_prefix="prefetch")
        # Editor and preview requests use _loader; exports use their own cache so a batch export
        # never evicts the photos being edited.
        budget = CacheBudget()
        self._loader = ImageLoader(budget=budget)
        self._export_loader = ImageLoader(capacity=2, scaled_capacity=0, budget=budget)
        self._prefetch_lock = threading.Lock()
        self._prefetch_tasks: OrderedDict[tuple, Future] = OrderedDict()
        self._color = ColorProcessor()
        self._masks = SemanticMaskProvider(self._loader)
        self._style = PhotographicStyleProcessor(self._masks)
        self._denoise = AIDenoiseEngine()
        self._upscale = RealESRGANEngine()
        self._writer = ExportWriter()

    def prefetch(self, row: Any) -> None:
        """Develop a photo into the editor caches in the background so switching to it is instant."""
        def warm():
            try:
                for edge in (1600, 512):
                    self._loader.load_scaled(row, edge)
            except Exception:
                pass  # The real request reports errors; a failed warm-up costs nothing.
        self._submit_prefetch(("editor", row["id"]), warm)

    def _submit_prefetch(self, key, action):
        # Keep only two queued requests plus the one already running. Obsolete pending work
        # is cancelable; Python cannot interrupt an active rawpy decode.
        with self._prefetch_lock:
            for old in list(self._prefetch_tasks):
                if self._prefetch_tasks[old].done():
                    self._prefetch_tasks.pop(old)
            if key in self._prefetch_tasks:
                return
            pending = [old for old, task in self._prefetch_tasks.items() if not task.running()]
            for old in pending[:-1]:
                if self._prefetch_tasks[old].cancel():
                    self._prefetch_tasks.pop(old)
            self._prefetch_tasks[key] = self._prefetcher.submit(action)

    def create(
        self,
        selected_ids: list[str],
        output_folder: str,
        settings: EnhanceSettings,
        settings_by_photo: dict[str, EnhanceSettings] | None = None,
    ) -> ExportJob:
        if not selected_ids:
            raise ExportEnhanceError("No photos selected")
        if not output_folder:
            raise ExportEnhanceError("output_folder is required")
        if not os.path.isdir(output_folder):
            raise ExportEnhanceError("Output folder does not exist")
        rows = [db.fetch_photo(photo_id) for photo_id in dict.fromkeys(selected_ids)]
        rows = [row for row in rows if row is not None]
        if not rows:
            raise ExportEnhanceError("No selected photos were found")
        settings_by_photo = settings_by_photo or {}
        job_id = f"enhance-{uuid4().hex}"
        # Each item stores the recipe it was queued with, so a resumed export renders the same
        # result even if the photo was edited in the meantime.
        db.insert_export_job(job_id, rows[0]["workspace_id"], output_folder, [
            {"photo_id": row["id"], "name": row["name"],
             "settings": serialize_settings(settings_by_photo.get(row["id"], settings))}
            for row in rows
        ])
        job = self._hydrate(job_id)
        with self._lock:
            self._jobs[job.id] = job
        self._executor.submit(self._run, job.id)
        self._publish(job)
        return job

    def _hydrate(self, job_id: str) -> ExportJob | None:
        found = db.fetch_export_job(job_id)
        if found is None:
            return None
        row, items = found
        job = ExportJob(
            id=row["id"],
            selected_ids=[item["photo_id"] for item in items],
            output_folder=row["output_folder"],
            settings=EnhanceSettings(),
            settings_by_photo={item["photo_id"]: parse_settings(json.loads(item["settings"])) for item in items},
            workspace_id=row["workspace_id"],
            status=row["status"],
            total=len(items),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
        job.processing_notes = list(json.loads(row["processing_notes"] or "[]"))
        job.item_status = {item["photo_id"]: item["status"] for item in items}
        job.outputs = [item["output_path"] for item in items if item["status"] == "done" and item["output_path"]]
        job.failures = [ExportFailure(photo_id=item["photo_id"], name=item["name"], error=item["error"] or "")
                        for item in items if item["status"] == "failed"]
        job.completed = len(job.outputs)
        job.failed = len(job.failures)
        return job

    def get(self, job_id: str) -> ExportJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
        return job or self._hydrate(job_id)

    def list(self, workspace_id: str, limit: int = 10) -> list[ExportJob]:
        return [job for job in (self.get(job_id) for job_id in db.list_export_job_ids(workspace_id, limit)) if job]

    def resume(self, job_id: str, retry_failed: bool = False) -> ExportJob | None:
        """Continue an interrupted or cancelled export; completed photos are never written again."""
        with self._lock:
            live = self._jobs.get(job_id)
            if live and live.status in ("queued", "running"):
                return live
        if retry_failed:
            db.requeue_failed_export_items(job_id)
        job = self._hydrate(job_id)
        if job is None:
            return None
        if "pending" not in job.item_status.values():
            return job
        if not os.path.isdir(job.output_folder):
            raise ExportEnhanceError("Output folder does not exist")
        job.status = "queued"
        db.update_export_job(job.id, status="queued")
        with self._lock:
            self._jobs[job.id] = job
        self._executor.submit(self._run, job.id)
        self._publish(job)
        return job

    def cancel(self, job_id: str) -> ExportJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.cancel_requested = True
                job.updated_at = time.time()
        if job:
            self._publish(job)
        return job

    def _decode_ahead(self, job: ExportJob, photo_ids: list[str], index: int) -> None:
        """Decode the next photo while the current one is processed (RAW decode is the longest stage)."""
        if index >= len(photo_ids) or job.cancel_requested:
            return
        row = db.fetch_photo(photo_ids[index])
        settings = job.settings_by_photo.get(row["id"], job.settings) if row is not None else None
        if settings is not None and settings.recipe_version >= 2:
            self._submit_prefetch(("export", row["id"]), lambda: self._export_loader.load(row))

    def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        if job is None:
            return
        self._update(job, status="running")
        pending = [photo_id for photo_id in job.selected_ids if job.item_status.get(photo_id, "pending") == "pending"]
        for index, photo_id in enumerate(pending):
            self._decode_ahead(job, pending, index + 1)
            if job.cancel_requested:
                self._update(job, status="cancelled", current=None)
                return
            row = db.fetch_photo(photo_id)
            if row is None:
                self._record_failure(job, photo_id, photo_id, "Photo not found")
                continue
            self._update(job, current=row["name"])
            try:
                settings = job.settings_by_photo.get(photo_id, job.settings)
                image, exif, _source = (self._export_loader.load(row) if settings.recipe_version >= 2 else self._export_loader.load_legacy(row))
                image = self._color.apply(image, settings)
                image = self._style.apply(image, settings, row)
                image = editing.apply_selected_color(image, settings.selected_color)
                image = editing.apply_gradient(image, settings.gradient)
                image = editing.apply_geometry(image, settings.crop)
                if settings.ai_denoise:
                    image, engine = self._denoise.apply_with_info(image, settings.ai_denoise_strength)
                    with self._lock:
                        note = f"Noise reduction: {engine}"
                        if note not in job.processing_notes:
                            job.processing_notes.append(note)
                            db.update_export_job(job.id, processing_notes=list(job.processing_notes))
                if settings.upscale:
                    image = self._upscale.apply(image, settings.upscale_scale)
                output = self._writer.write(image, row, job.output_folder, settings, exif)
                db.update_export_item(job.id, photo_id, "done", output_path=output)
                with self._lock:
                    job.item_status[photo_id] = "done"
                    job.outputs.append(output)
                    job.completed += 1
                    job.updated_at = time.time()
            except Exception as exc:
                self._record_failure(job, photo_id, row["name"], str(exc) or traceback.format_exc(limit=1))
                continue
            self._publish(job)
        self._update(job, status="done", current=None)

    def _record_failure(self, job: ExportJob, photo_id: str, name: str, error: str) -> None:
        db.update_export_item(job.id, photo_id, "failed", error=error[:500])
        with self._lock:
            job.item_status[photo_id] = "failed"
            job.failures.append(ExportFailure(photo_id=photo_id, name=name, error=error[:500]))
            job.failed += 1
            job.updated_at = time.time()
        self._publish(job)

    def _update(self, job: ExportJob, **updates: Any) -> None:
        with self._lock:
            for key, value in updates.items():
                setattr(job, key, value)
            job.updated_at = time.time()
        if "status" in updates:
            db.update_export_job(job.id, status=updates["status"])
        self._publish(job)

    def _publish(self, job: ExportJob) -> None:
        events.publish("export-enhance:update", job.workspace_id, serialize_job(job))


def serialize_job(job: ExportJob) -> dict[str, Any]:
    pending = sum(1 for status in job.item_status.values() if status == "pending")
    return {
        "id": job.id,
        "status": job.status,
        "total": job.total,
        "completed": job.completed,
        "failed": job.failed,
        "current": job.current,
        "outputFolder": job.output_folder,
        "outputs": list(job.outputs),
        "failures": [failure.__dict__ for failure in job.failures],
        "processingNotes": list(job.processing_notes),
        "pending": pending,
        # Interrupted (restart) or cancelled jobs can continue with the photos not yet written.
        "resumable": job.status in ("interrupted", "cancelled") and pending > 0,
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
    }


queue = JobQueue()


def render_detail(photo_id: str, settings: EnhanceSettings, region: dict, original: bool = False):
    """Native-size output tile. Only process its source footprint, including resampling/filter halo.

    V2 color/style operations are per-pixel. Bicubic needs a two-pixel source halo; sharpening
    needs one output pixel. Keeping both makes internal tile edges agree with a full export.
    Output resize and optional model stages are deliberately excluded (and rejected).
    """
    if settings.recipe_version != 2 or settings.ai_denoise or settings.upscale:
        raise ExportEnhanceError("100% detail requires the current color engine with noise reduction and upscale off")
    row = db.fetch_photo(photo_id)
    if row is None:
        raise ExportEnhanceError("Photo not found")
    if not isinstance(region, dict):
        raise ExportEnhanceError("region must be an object")
    # Validate before decoding; clients cannot request a full 48MP processed frame.
    values = {}
    for key in ("x", "y", "width", "height"):
        value = region.get(key)
        if type(value) is not int or value < (1 if key in {"width", "height"} else 0):
            raise ExportEnhanceError(f"region.{key} must be a positive size or nonnegative position")
        values[key] = value
    if values["width"] > 1536 or values["height"] > 1536:
        raise ExportEnhanceError("Detail tiles must be at most 1536 pixels per edge")
    source = queue._loader.load(row)[0]
    h, w = source.shape[:2]
    ow, oh, cx, cy, c, s = editing.geometry(w, h, settings.crop)
    x, y = min(values["x"], ow - 1), min(values["y"], oh - 1)
    tw, th = min(values["width"], ow - x), min(values["height"], oh - y)
    left, top, right, bottom = max(0, x - 1), max(0, y - 1), min(ow, x + tw + 1), min(oh, y + th + 1)
    def mapped(px, py):
        return cx + c * (px - ow / 2) - s * (py - oh / 2), cy + s * (px - ow / 2) + c * (py - oh / 2)
    corners = [mapped(px, py) for px in (left, right) for py in (top, bottom)]
    sx, sy = max(0, math.floor(min(p[0] for p in corners)) - 4), max(0, math.floor(min(p[1] for p in corners)) - 4)
    ex, ey = min(w, math.ceil(max(p[0] for p in corners)) + 4), min(h, math.ceil(max(p[1] for p in corners)) + 4)
    image = source[sy:ey, sx:ex]
    if not original:
        image = queue._style.apply(queue._color.apply(image, settings), settings, row)
        image = editing.apply_selected_color(image, settings.selected_color)
        image = editing.apply_gradient(image, settings.gradient, (sx, sy), (w, h))
    ox, oy = mapped(left, top)
    affine = (c, -s, ox - sx, s, c, oy - sy)
    image = np.stack([np.asarray(Image.fromarray(image[..., channel], "F").transform(
        (right - left, bottom - top), Image.Transform.AFFINE, affine, Image.Resampling.BICUBIC))
        for channel in range(3)], axis=-1)
    image = np.clip(image, 0, 1)
    if not original:
        image = editing.sharpen_float(image, settings.sharpen)
    return image[y - top:y - top + th, x - left:x - left + tw], (ow, oh, x, y)


def render_preview(photo_id: str, settings: EnhanceSettings, max_edge: int = 1600) -> io.BytesIO:
    row = db.fetch_photo(photo_id)
    if row is None:
        raise ExportEnhanceError("Photo not found")
    if settings.recipe_version >= 2:
        image = queue._loader.load_scaled(row, max_edge)
    else:
        image = editing.resize_float(queue._loader.load_legacy(row)[0], max_edge)
    image = queue._color.apply(image, settings)
    image = queue._style.apply(image, settings, row)
    image = editing.apply_selected_color(image, settings.selected_color)
    image = editing.apply_gradient(image, settings.gradient)
    image = editing.apply_geometry(image, settings.crop)
    engine = "Off"
    if settings.ai_denoise:
        image, engine = queue._denoise.apply_with_info(image, settings.ai_denoise_strength)
    if settings.upscale:
        image = queue._upscale.apply(image, settings.upscale_scale)
    image = editing.sharpen_float(image, settings.sharpen)
    preview = io.BytesIO()
    Image.fromarray((np.clip(image, 0, 1) * 255.0 + 0.5).astype(np.uint8), "RGB").save(preview, "JPEG", quality=95, subsampling=0, icc_profile=editing.SRGB_ICC)
    preview.seek(0)
    preview.denoise_engine = engine
    return preview


MATCH_LIMIT_EV = 1.0


def _render_for_stats(row: Any, settings: EnhanceSettings, max_edge: int = 512) -> np.ndarray:
    image = queue._loader.load_scaled(row, max_edge)
    image = queue._color.apply(image, settings)
    image = queue._style.apply(image, settings, row)
    image = editing.apply_selected_color(image, settings.selected_color)
    image = editing.apply_gradient(image, settings.gradient)
    return editing.apply_geometry(image, settings.crop)


def match_exposure(reference_id: str, reference_settings: EnhanceSettings,
                   targets: dict[str, EnhanceSettings], limit: float = MATCH_LIMIT_EV) -> dict[str, Any]:
    """Propose exposure changes so queued photos match the reference's rendered midtones.

    Only exposure changes; white balance, crop and everything else stay as they are. Changes
    are capped at +/-limit EV, and photos whose scene differs from the reference (night,
    silhouette) are left alone rather than forced to look alike.
    """
    reference = db.fetch_photo(reference_id)
    if reference is None:
        raise ExportEnhanceError("Reference photo not found")
    if reference_settings.recipe_version < 2:
        raise ExportEnhanceError("Switch the reference photo to the new controls first")
    ref_stats = editing.luminance_stats(_render_for_stats(reference, reference_settings))
    ref_kind = editing.scene_kind(ref_stats)
    target_linear = float(editing.decode_srgb(np.float32(ref_stats["median"])))
    results = []
    for photo_id, settings in targets.items():
        row = db.fetch_photo(photo_id)
        base = {"photoId": photo_id, "name": row["name"] if row else photo_id, "exposure": settings.exposure}
        if row is None:
            results.append({**base, "status": "skip", "reason": "Photo not found"})
            continue
        if settings.recipe_version < 2:
            results.append({**base, "status": "skip", "reason": "Legacy edit; switch to the new controls first"})
            continue
        stats = editing.luminance_stats(_render_for_stats(row, settings))
        clipped_before = stats["clipped"]
        kind = editing.scene_kind(stats)
        if kind != ref_kind:
            results.append({**base, "status": "skip", "reason": f"{kind.capitalize()} scene; the reference is {ref_kind}"})
            continue
        # Exposure acts in linear light before the tone controls, so refine a few times.
        delta = 0.0
        for _ in range(3):
            current = float(editing.decode_srgb(np.float32(stats["median"])))
            step = math.log2(max(target_linear, 1e-4) / max(current, 1e-4))
            delta = max(-limit, min(limit, delta + step))
            proposed = max(-3.0, min(3.0, settings.exposure + delta))
            stats = editing.luminance_stats(_render_for_stats(row, replace(settings, exposure=proposed)))
            if abs(step) < 0.01:
                break
        # Brightening must not blow out skies or the sun: back off while clipping grows by >1%.
        highlight_limited = False
        while delta > 0.03 and stats["clipped"] > clipped_before + 0.01:
            highlight_limited = True
            delta = max(0.0, delta - 0.15)
            proposed = max(-3.0, min(3.0, settings.exposure + delta))
            stats = editing.luminance_stats(_render_for_stats(row, replace(settings, exposure=proposed)))
        if abs(delta) < 0.03:
            if highlight_limited:
                results.append({**base, "status": "skip", "reason": "Brightening would clip highlights"})
                continue
            results.append({**base, "status": "unchanged", "reason": "Already matches"})
            continue
        results.append({**base, "status": "adjust", "proposed": round(proposed, 2), "deltaEv": round(delta, 2),
                        "limited": abs(delta) >= limit - 1e-6,
                        "reason": "Limited to protect highlights" if highlight_limited else ""})
    return {"referenceId": reference_id, "scene": ref_kind, "limitEv": limit, "results": results}


def render_style_masks(photo_id: str, max_edge: int = 1024) -> dict[str, Any]:
    row = db.fetch_photo(photo_id)
    if row is None:
        raise ExportEnhanceError("Photo not found")
    max_edge = max(128, min(2048, int(max_edge)))
    return queue._masks.masks_data_url_for_row(row, max_edge=max_edge)

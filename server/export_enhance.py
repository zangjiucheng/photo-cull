from __future__ import annotations

import importlib.util
import base64
import io
import os
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from . import db, events, raw_pipeline


RESTORMER_ARCH_URL = "https://raw.githubusercontent.com/swz30/Restormer/main/basicsr/models/archs/restormer_arch.py"
RESTORMER_WEIGHTS = {
    "denoise": "https://github.com/swz30/Restormer/releases/download/v1.0/real_denoising.pth",
    "deblur": "https://github.com/swz30/Restormer/releases/download/v1.0/motion_deblurring.pth",
}
STRENGTH_ALPHA = {"low": 0.35, "medium": 0.65, "high": 1.0}
MIN_WEIGHT_BYTES = 1_000_000
STYLE_PRESETS = {"standard", "bright", "dramatic", "warm", "cool", "muted"}


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
    exposure: float = 0.0
    contrast: float = 0.0
    highlights: float = 0.0
    shadows: float = 0.0
    saturation: float = 0.0
    temperature: float = 0.0
    tint: float = 0.0
    ai_denoise: bool = False
    ai_deblur: bool = False
    strength: str = "medium"
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
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    cancel_requested: bool = False


def _float_setting(settings: dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(settings.get(key, default))
    except (TypeError, ValueError):
        raise ExportEnhanceError(f"{key} must be a number")
    return max(low, min(high, value))


def parse_settings(raw: dict[str, Any] | None) -> EnhanceSettings:
    settings = raw or {}
    style_raw = settings.get("photoStyle", settings.get("photo_style", {}))
    style_raw = style_raw if isinstance(style_raw, dict) else {}
    preset = str(style_raw.get("preset", "standard")).lower()
    if preset not in STYLE_PRESETS:
        preset = "standard"
    output_format = str(settings.get("outputFormat", settings.get("output_format", "jpeg"))).lower()
    if output_format not in {"jpeg", "tiff"}:
        raise ExportEnhanceError("outputFormat must be jpeg or tiff")
    strength = str(settings.get("strength", "medium")).lower()
    if strength not in STRENGTH_ALPHA:
        raise ExportEnhanceError("strength must be low, medium, or high")
    quality = int(settings.get("quality", 92))
    if quality < 1 or quality > 100:
        raise ExportEnhanceError("quality must be between 1 and 100")
    resize = settings.get("resizeMaxEdge", settings.get("resize_max_edge"))
    resize_max_edge = None
    if resize not in {None, "", 0}:
        resize_max_edge = int(resize)
        if resize_max_edge < 256:
            raise ExportEnhanceError("resizeMaxEdge must be at least 256")
    return EnhanceSettings(
        exposure=_float_setting(settings, "exposure", 0.0, -3.0, 3.0),
        contrast=_float_setting(settings, "contrast", 0.0, -1.0, 1.0),
        highlights=_float_setting(settings, "highlights", 0.0, -1.0, 1.0),
        shadows=_float_setting(settings, "shadows", 0.0, -1.0, 1.0),
        saturation=_float_setting(settings, "saturation", 0.0, -1.0, 1.0),
        temperature=_float_setting(settings, "temperature", 0.0, -1.0, 1.0),
        tint=_float_setting(settings, "tint", 0.0, -1.0, 1.0),
        ai_denoise=bool(settings.get("aiDenoise", settings.get("ai_denoise", False))),
        ai_deblur=bool(settings.get("aiDeblur", settings.get("ai_deblur", False))),
        strength=strength,
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


class ImageLoader:
    def load(self, row: Any) -> tuple[np.ndarray, bytes | None, str]:
        source_path = row["path"]
        path = raw_pipeline.display_path_for_row(row)
        exif = None
        try:
            with Image.open(source_path) as source:
                exif = source.info.get("exif")
        except Exception:
            exif = None
        with Image.open(path) as image:
            rgb = ImageOps.exif_transpose(image).convert("RGB")
            arr = np.asarray(rgb, dtype=np.float32) / 255.0
        return arr, exif, source_path


class ColorProcessor:
    def apply(self, image: np.ndarray, settings: EnhanceSettings) -> np.ndarray:
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
    def __init__(self):
        self._cache: dict[tuple[str, int], np.ndarray] = {}
        self._lock = threading.Lock()
        self._torch_plugin_checked = False
        self._torch_plugin: Any | None = None

    def masks_for_row(self, row: Any, image: np.ndarray | None = None, max_edge: int | None = None) -> np.ndarray:
        source = str(row["path"])
        cache_key = (source, max_edge or 0)
        with self._lock:
            cached = self._cache.get(cache_key)
        if cached is not None:
            return cached.copy()
        if image is None:
            image, _exif, _source = ImageLoader().load(row)
        if max_edge and max(image.shape[:2]) > max_edge:
            pil = Image.fromarray((image * 255.0 + 0.5).astype(np.uint8), "RGB")
            pil.thumbnail((max_edge, max_edge), Image.Resampling.BILINEAR)
            image = np.asarray(pil, dtype=np.float32) / 255.0
        masks = self._build_masks(image)
        with self._lock:
            self._cache[cache_key] = masks.copy()
        return masks

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


class TileInferenceEngine:
    def __init__(self, tile_size: int = 512, overlap: int = 64):
        self.tile_size = tile_size
        self.overlap = overlap

    def run(self, image: np.ndarray, infer_tile) -> np.ndarray:
        height, width = image.shape[:2]
        tile = self.tile_size
        step = max(1, tile - self.overlap)
        output = np.zeros_like(image, dtype=np.float32)
        weights = np.zeros((height, width, 1), dtype=np.float32)
        ramp = np.hanning(tile)
        feather = np.outer(ramp, ramp).astype(np.float32)
        feather = np.maximum(feather, 0.05)[..., None]

        for y in range(0, height, step):
            for x in range(0, width, step):
                y0 = min(y, max(height - tile, 0))
                x0 = min(x, max(width - tile, 0))
                patch = image[y0:min(y0 + tile, height), x0:min(x0 + tile, width)]
                patch_out = infer_tile(patch)
                local_weight = feather[: patch.shape[0], : patch.shape[1]]
                output[y0:y0 + patch.shape[0], x0:x0 + patch.shape[1]] += patch_out * local_weight
                weights[y0:y0 + patch.shape[0], x0:x0 + patch.shape[1]] += local_weight
        return np.clip(output / np.maximum(weights, 1e-6), 0.0, 1.0)


class RestormerEngine:
    def __init__(self, model_dir: str | None = None):
        self._model_dir_override = model_dir
        self._models: dict[str, Any] = {}
        self._tile_engine = TileInferenceEngine()

    @property
    def model_dir(self) -> Path:
        base = self._model_dir_override or os.getenv("AI_RUNTIME_MODEL_DIR") or os.path.join(os.path.dirname(db.get_config().db_path), "ai-runtime", "models")
        return Path(base) / "restormer"

    def available(self) -> dict[str, bool]:
        return {name: (self.model_dir / f"{name}.pth").exists() for name in RESTORMER_WEIGHTS}

    def ensure_ready(self, tasks: list[str]) -> None:
        if importlib.util.find_spec("torch") is None:
            raise ExportEnhanceError("AI Runtime with PyTorch is required for Enhance & Export.")
        if importlib.util.find_spec("einops") is None:
            raise ExportEnhanceError("AI Runtime is missing einops. Reinstall AI Runtime.")
        self.model_dir.mkdir(parents=True, exist_ok=True)
        arch_path = self.model_dir / "restormer_arch.py"
        if not arch_path.exists():
            self._download_file(RESTORMER_ARCH_URL, arch_path)
        for task in tasks:
            target = self.model_dir / f"{task}.pth"
            if not self._looks_like_checkpoint(target):
                target.unlink(missing_ok=True)
                self._download_file(RESTORMER_WEIGHTS[task], target)
                if not self._looks_like_checkpoint(target):
                    target.unlink(missing_ok=True)
                    raise ExportEnhanceError(f"Downloaded Restormer {task} weights are invalid. Check network access and retry.")

    def _download_file(self, url: str, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp_path = target.with_suffix(f"{target.suffix}.download")
        temp_path.unlink(missing_ok=True)
        urllib.request.urlretrieve(url, temp_path)
        temp_path.replace(target)

    def _looks_like_checkpoint(self, target: Path) -> bool:
        if not target.exists() or target.stat().st_size < MIN_WEIGHT_BYTES:
            return False
        try:
            return zipfile.is_zipfile(target)
        except OSError:
            return False

    def _device(self):
        import torch

        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return torch.device("mps")
        if torch.cuda.is_available():
            return torch.device("cuda")
        return torch.device("cpu")

    def _load_model(self, task: str):
        if task in self._models:
            return self._models[task]
        import torch

        arch_path = self.model_dir / "restormer_arch.py"
        spec = importlib.util.spec_from_file_location("ai_culling_restormer_arch", arch_path)
        if spec is None or spec.loader is None:
            raise ExportEnhanceError("Could not load Restormer architecture.")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        model = module.Restormer()
        checkpoint_path = self.model_dir / f"{task}.pth"
        try:
            checkpoint = torch.load(checkpoint_path, map_location="cpu")
        except RuntimeError as exc:
            checkpoint_path.unlink(missing_ok=True)
            self._models.pop(task, None)
            raise ExportEnhanceError(f"Restormer {task} weights were corrupted and removed. Retry Render Preview to download them again.") from exc
        state = checkpoint.get("params") if isinstance(checkpoint, dict) and "params" in checkpoint else checkpoint
        if isinstance(state, dict):
            state = {key.removeprefix("module."): value for key, value in state.items()}
        model.load_state_dict(state, strict=False)
        model.to(self._device())
        model.eval()
        self._models[task] = model
        return model

    def apply(self, image: np.ndarray, task: str, strength: str) -> np.ndarray:
        self.ensure_ready([task])
        model = self._load_model(task)
        alpha = STRENGTH_ALPHA[strength]
        restored = self._tile_engine.run(image, lambda patch: self._infer_patch(model, patch))
        return np.clip(image * (1.0 - alpha) + restored * alpha, 0.0, 1.0).astype(np.float32)

    def _infer_patch(self, model: Any, patch: np.ndarray) -> np.ndarray:
        import torch

        device = self._device()
        height, width = patch.shape[:2]
        pad_h = (8 - height % 8) % 8
        pad_w = (8 - width % 8) % 8
        padded = np.pad(patch, ((0, pad_h), (0, pad_w), (0, 0)), mode="reflect")
        tensor = torch.from_numpy(np.transpose(padded, (2, 0, 1))).unsqueeze(0).to(device=device, dtype=torch.float32)
        with torch.no_grad():
            out = model(tensor).clamp(0, 1)
        arr = out.squeeze(0).detach().cpu().numpy()
        if device.type == "cuda":
            torch.cuda.empty_cache()
        arr = np.transpose(arr, (1, 2, 0))[:height, :width]
        return arr.astype(np.float32)


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

        out = np.clip(image, 0.0, 1.0)
        if settings.resize_max_edge:
            pil = Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), "RGB")
            pil.thumbnail((settings.resize_max_edge, settings.resize_max_edge), Image.Resampling.LANCZOS)
            out = np.asarray(pil, dtype=np.float32) / 255.0
        if settings.sharpen:
            pil = Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), "RGB")
            radius = 1.0
            percent = int(60 + settings.sharpen * 90)
            pil = pil.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=3))
            out = np.asarray(pil, dtype=np.float32) / 255.0

        if settings.output_format == "jpeg":
            pil = Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), "RGB")
            save_kwargs = {"quality": settings.quality, "subsampling": 0, "optimize": True}
            if exif:
                save_kwargs["exif"] = exif
            pil.save(output_path, "JPEG", **save_kwargs)
        else:
            arr16 = (out * 65535.0 + 0.5).astype(np.uint16)
            import tifffile

            tifffile.imwrite(output_path, arr16, photometric="rgb")
        return str(output_path)


class JobQueue:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, ExportJob] = {}
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._loader = ImageLoader()
        self._color = ColorProcessor()
        self._masks = SemanticMaskProvider()
        self._style = PhotographicStyleProcessor(self._masks)
        self._restormer = RestormerEngine()
        self._writer = ExportWriter()

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
        tasks = []
        all_settings = [settings, *(settings_by_photo or {}).values()]
        if any(item.ai_denoise for item in all_settings):
            tasks.append("denoise")
        if any(item.ai_deblur for item in all_settings):
            tasks.append("deblur")
        if tasks:
            self._restormer.ensure_ready(tasks)
        job = ExportJob(
            id=f"enhance-{int(time.time() * 1000)}",
            selected_ids=[row["id"] for row in rows],
            output_folder=output_folder,
            settings=settings,
            settings_by_photo=settings_by_photo or {},
            workspace_id=rows[0]["workspace_id"],
            total=len(rows),
        )
        with self._lock:
            self._jobs[job.id] = job
        self._executor.submit(self._run, job.id)
        self._publish(job)
        return job

    def get(self, job_id: str) -> ExportJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> ExportJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.cancel_requested = True
                job.updated_at = time.time()
        if job:
            self._publish(job)
        return job

    def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        if job is None:
            return
        self._update(job, status="running")
        for photo_id in job.selected_ids:
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
                image, exif, _source = self._loader.load(row)
                image = self._color.apply(image, settings)
                image = self._style.apply(image, settings, row)
                if settings.ai_denoise:
                    image = self._restormer.apply(image, "denoise", settings.strength)
                if settings.ai_deblur:
                    image = self._restormer.apply(image, "deblur", settings.strength)
                output = self._writer.write(image, row, job.output_folder, settings, exif)
                with self._lock:
                    job.outputs.append(output)
                    job.completed += 1
                    job.updated_at = time.time()
            except Exception as exc:
                self._record_failure(job, photo_id, row["name"], str(exc) or traceback.format_exc(limit=1))
                continue
            self._publish(job)
        self._update(job, status="done", current=None)

    def _record_failure(self, job: ExportJob, photo_id: str, name: str, error: str) -> None:
        with self._lock:
            job.failures.append(ExportFailure(photo_id=photo_id, name=name, error=error[:500]))
            job.failed += 1
            job.updated_at = time.time()
        self._publish(job)

    def _update(self, job: ExportJob, **updates: Any) -> None:
        with self._lock:
            for key, value in updates.items():
                setattr(job, key, value)
            job.updated_at = time.time()
        self._publish(job)

    def _publish(self, job: ExportJob) -> None:
        events.publish("export-enhance:update", job.workspace_id, serialize_job(job))


def serialize_job(job: ExportJob) -> dict[str, Any]:
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
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
    }


queue = JobQueue()


def render_preview(photo_id: str, settings: EnhanceSettings, max_edge: int = 1600) -> str:
    row = db.fetch_photo(photo_id)
    if row is None:
        raise ExportEnhanceError("Photo not found")
    image, _exif, _source = queue._loader.load(row)
    if max(image.shape[:2]) > max_edge:
        pil = Image.fromarray((image * 255.0 + 0.5).astype(np.uint8), "RGB")
        pil.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        image = np.asarray(pil, dtype=np.float32) / 255.0
    image = queue._color.apply(image, settings)
    image = queue._style.apply(image, settings, row)
    if settings.ai_denoise:
        image = queue._restormer.apply(image, "denoise", settings.strength)
    if settings.ai_deblur:
        image = queue._restormer.apply(image, "deblur", settings.strength)
    if settings.sharpen:
        pil = Image.fromarray((image * 255.0 + 0.5).astype(np.uint8), "RGB")
        pil = pil.filter(ImageFilter.UnsharpMask(radius=1.0, percent=int(60 + settings.sharpen * 90), threshold=3))
        image = np.asarray(pil, dtype=np.float32) / 255.0
    preview_dir = Path(tempfile.gettempdir()) / "ai-culling-enhance-previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview_path = preview_dir / f"{photo_id}-{int(time.time() * 1000)}.jpg"
    Image.fromarray((np.clip(image, 0, 1) * 255.0 + 0.5).astype(np.uint8), "RGB").save(preview_path, "JPEG", quality=92)
    return str(preview_path)


def render_style_masks(photo_id: str, max_edge: int = 1024) -> dict[str, Any]:
    row = db.fetch_photo(photo_id)
    if row is None:
        raise ExportEnhanceError("Photo not found")
    max_edge = max(128, min(2048, int(max_edge)))
    return queue._masks.masks_data_url_for_row(row, max_edge=max_edge)

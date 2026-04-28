from __future__ import annotations

import importlib
import importlib.util
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

from . import db, raw_pipeline
from .config import AppConfig


_config = AppConfig()
_executor = ThreadPoolExecutor(max_workers=_config.score_workers)
_running_jobs: set[str] = set()
_jobs_lock = threading.Lock()
_metrics: dict[str, "LoadedMetric"] = {}
_metric_errors: dict[str, str] = {}
_score_mode = "multi:balanced"
_metrics_loaded = False


@dataclass
class LoadedMetric:
    group: str
    name: str
    weight: float
    model: Any
    lower_better: bool
    score_range: tuple[float, float] | None


BALANCED_PROFILE = {
    "technical": {"candidates": ["topiq_nr", "musiq"], "weight": 0.45},
    "aesthetic": {"candidates": ["nima", "clipiqa"], "weight": 0.25},
    "distortion": {"candidates": ["brisque", "niqe"], "weight": 0.20},
}

FALLBACK_RANGES: dict[str, tuple[float, float]] = {
    "topiq_nr": (0.0, 1.0),
    "musiq": (0.0, 100.0),
    "nima": (0.0, 10.0),
    "clipiqa": (0.0, 1.0),
    "brisque": (0.0, 100.0),
    "niqe": (0.0, 20.0),
}


def configure(config: AppConfig) -> None:
    global _config, _executor, _metrics, _metric_errors, _score_mode, _metrics_loaded
    _config = config
    _executor.shutdown(wait=False, cancel_futures=True)
    _executor = ThreadPoolExecutor(max_workers=_config.score_workers)
    _metrics = {}
    _metric_errors = {}
    _score_mode = "multi:balanced"
    _metrics_loaded = False


def _resolve_device() -> str:
    configured = os.getenv("IQA_DEVICE", "cpu").strip().lower()
    if configured == "cpu":
        return "cpu"
    try:
        torch = importlib.import_module("torch")
        if configured == "cuda" and torch.cuda.is_available():
            return "cuda"
        if configured == "mps" and hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _coerce_score_range(value: object) -> tuple[float, float] | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)) and len(value) == 2:
        try:
            low = float(value[0])
            high = float(value[1])
        except (TypeError, ValueError):
            return None
        if math.isfinite(low) and math.isfinite(high) and low != high:
            return (min(low, high), max(low, high))
    return None


def load_metrics(profile: str = "balanced") -> None:
    global _metrics, _metric_errors, _score_mode, _metrics_loaded
    if _metrics_loaded:
        return
    _metrics_loaded = True
    if importlib.util.find_spec("pyiqa") is None:
        _score_mode = "heuristic:enhanced"
        return

    try:
        pyiqa = importlib.import_module("pyiqa")
        available = set(pyiqa.list_models())
        device = _resolve_device()
        loaded: dict[str, LoadedMetric] = {}
        errors: dict[str, str] = {}
        for group, config in BALANCED_PROFILE.items():
            for name in config["candidates"]:
                if name not in available:
                    continue
                try:
                    model = pyiqa.create_metric(name, device=device)
                    loaded[group] = LoadedMetric(
                        group=group,
                        name=name,
                        weight=float(config["weight"]),
                        model=model,
                        lower_better=bool(getattr(model, "lower_better", False)),
                        score_range=_coerce_score_range(getattr(model, "score_range", None)),
                    )
                    break
                except Exception as exc:
                    errors[name] = str(exc)[:300]
            if group not in loaded and group not in errors:
                errors[group] = "No configured metric is available"

        _metrics = loaded
        _metric_errors = errors
        metric_names = [metric.name for metric in loaded.values()]
        _score_mode = f"multi:{profile}[{','.join([*metric_names, 'heuristics'])}]" if metric_names else "heuristic:enhanced"
    except Exception as exc:
        _metrics = {}
        _metric_errors = {"pyiqa": str(exc)[:300]}
        _score_mode = "heuristic:enhanced"


def score_mode() -> str:
    return _score_mode


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def normalize_metric_score(
    name: str,
    raw_value: float,
    lower_better: bool,
    score_range: tuple[float, float] | None = None,
) -> float:
    metric_range = score_range or FALLBACK_RANGES.get(name)
    if metric_range is None:
        if 0 <= raw_value <= 1:
            metric_range = (0.0, 1.0)
        elif 0 <= raw_value <= 10:
            metric_range = (0.0, 10.0)
        else:
            metric_range = (0.0, 100.0)

    low, high = metric_range
    if high == low:
        return 50.0
    ratio = (raw_value - low) / (high - low)
    if lower_better:
        ratio = 1.0 - ratio
    return _clamp(ratio * 100.0)


def heuristic_details(img: Image.Image) -> dict[str, float]:
    rgb = img.convert("RGB")
    arr = np.asarray(rgb, dtype=np.float32)
    gray = arr.mean(axis=2)
    gradients = np.gradient(gray)
    gradient_energy = float(np.mean(gradients[0] ** 2 + gradients[1] ** 2))
    sharpness = _clamp((math.log1p(gradient_energy) / math.log1p(1200.0)) * 100.0)

    brightness = float(gray.mean() / 255.0)
    exposure = _clamp((1.0 - min(abs(brightness - 0.45) / 0.45, 1.0)) * 100.0)
    contrast = _clamp((float(gray.std()) / 64.0) * 100.0)
    clipped = float(np.mean((gray <= 4) | (gray >= 251)))
    clipping = _clamp((1.0 - min(clipped / 0.20, 1.0)) * 100.0)
    final = 0.35 * sharpness + 0.25 * exposure + 0.25 * contrast + 0.15 * clipping

    return {
        "sharpness": round(sharpness, 4),
        "exposure": round(exposure, 4),
        "contrast": round(contrast, 4),
        "clipping": round(clipping, 4),
        "brightness": round(brightness, 4),
        "clippedRatio": round(clipped, 6),
        "normalized": round(_clamp(final), 4),
    }


def heuristic_score(img: Image.Image) -> float:
    return float(heuristic_details(img)["normalized"])


def _score_to_float(score: object) -> float:
    if hasattr(score, "item"):
        return float(score.item())
    return float(score)


def score_image_multi(path: str) -> tuple[float, dict[str, Any]]:
    load_metrics()
    with Image.open(path) as img:
        heuristics = heuristic_details(img)

    details: dict[str, Any] = {
        "mode": "multi:balanced" if _metrics else "heuristic:enhanced",
        "metrics": {},
        "heuristics": heuristics,
        "errors": dict(_metric_errors),
    }
    weighted: list[tuple[float, float]] = []

    for metric in _metrics.values():
        metric_detail: dict[str, Any] = {
            "group": metric.group,
            "weight": metric.weight,
            "lowerBetter": metric.lower_better,
            "scoreRange": list(metric.score_range) if metric.score_range else list(FALLBACK_RANGES.get(metric.name, (0.0, 100.0))),
        }
        try:
            raw_value = _score_to_float(metric.model(path))
            normalized = normalize_metric_score(metric.name, raw_value, metric.lower_better, metric.score_range)
            metric_detail.update({
                "raw": round(raw_value, 6),
                "normalized": round(normalized, 4),
                "status": "ok",
            })
            weighted.append((normalized, metric.weight))
        except Exception as exc:
            metric_detail.update({
                "status": "error",
                "error": str(exc)[:300],
            })
            details["errors"][metric.name] = str(exc)[:300]
        details["metrics"][metric.name] = metric_detail

    weighted.append((float(heuristics["normalized"]), 0.10))
    total_weight = sum(weight for _value, weight in weighted)
    final_score = sum(value * weight for value, weight in weighted) / total_weight if total_weight else float(heuristics["normalized"])
    final_score = round(_clamp(final_score), 2)
    details["final"] = final_score
    return final_score, details


def score_image(path: str) -> float:
    score_value, _details = score_image_multi(path)
    return score_value


def score_job(photo_id: str, path: str) -> None:
    try:
        db.mark_processing(photo_id)
        scoring_path = raw_pipeline.ensure_display_image(path)
        score_value, score_details = score_image_multi(scoring_path)
        db.mark_done(photo_id, score_value, score_details)
    except Exception as exc:
        db.mark_error(photo_id, exc)
    finally:
        with _jobs_lock:
            _running_jobs.discard(photo_id)


def enqueue_scoring(photo_id: str, path: str) -> None:
    with _jobs_lock:
        if photo_id in _running_jobs:
            return
        _running_jobs.add(photo_id)
    _executor.submit(score_job, photo_id, path)


def discard_jobs(photo_ids: list[str]) -> None:
    with _jobs_lock:
        for photo_id in photo_ids:
            _running_jobs.discard(photo_id)


def running_count() -> int:
    with _jobs_lock:
        return len(_running_jobs)

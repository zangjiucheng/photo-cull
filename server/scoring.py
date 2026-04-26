from __future__ import annotations

import importlib
import importlib.util
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

from . import db
from .config import AppConfig


_config = AppConfig()
_executor = ThreadPoolExecutor(max_workers=_config.score_workers)
_running_jobs: set[str] = set()
_jobs_lock = threading.Lock()
_model = None
_score_mode = "heuristic"


def configure(config: AppConfig) -> None:
    global _config, _executor
    _config = config
    _executor.shutdown(wait=False, cancel_futures=True)
    _executor = ThreadPoolExecutor(max_workers=_config.score_workers)


def load_model() -> None:
    global _model, _score_mode
    if _model is not None:
        return
    if importlib.util.find_spec("pyiqa") is None:
        _score_mode = "heuristic"
        return
    try:
        pyiqa = importlib.import_module("pyiqa")
        _model = pyiqa.create_metric("musiq", device="cpu")
        _score_mode = "pyiqa:musiq"
    except Exception:
        _model = None
        _score_mode = "heuristic"


def score_mode() -> str:
    load_model()
    return _score_mode


def heuristic_score(img: Image.Image) -> float:
    arr = np.array(img)
    sharpness = np.var(arr)
    brightness = arr.mean()
    return float(0.5 * sharpness + 0.5 * brightness)


def score_image(path: str) -> float:
    load_model()
    if _model is not None:
        score = _model(path)
        return float(score.item())
    with Image.open(path) as img:
        return heuristic_score(img.convert("RGB"))


def score_job(photo_id: str, path: str) -> None:
    try:
        db.mark_processing(photo_id)
        score_value = score_image(path)
        db.mark_done(photo_id, score_value)
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

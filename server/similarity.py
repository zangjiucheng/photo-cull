from __future__ import annotations

import importlib.util
import copy
import hashlib
import json
import os
import threading
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np
from PIL import ExifTags, Image

from . import db, storage

PHASH_EXACT_DISTANCE = 5
PHASH_REVIEW_DISTANCE = 12
CLIP_HIGH_SIMILARITY = 0.92
CLIP_REVIEW_SIMILARITY = 0.85
SIMILARITY_CACHE_MAX_ITEMS = 32

_result_cache: dict[tuple, dict] = {}
_result_cache_lock = threading.Lock()


@dataclass
class PhotoCandidate:
    row: Any
    path: str
    metadata: dict
    phash: int
    clip_embedding: np.ndarray | None = None


def _dct_matrix(size: int) -> np.ndarray:
    matrix = np.zeros((size, size), dtype=np.float64)
    factor = np.pi / (2 * size)
    scale = np.sqrt(2 / size)
    for row in range(size):
        alpha = np.sqrt(1 / size) if row == 0 else scale
        for col in range(size):
            matrix[row, col] = alpha * np.cos((2 * col + 1) * row * factor)
    return matrix


@lru_cache(maxsize=4)
def _cached_dct_matrix(size: int) -> np.ndarray:
    return _dct_matrix(size)


def perceptual_hash(path: str, hash_size: int = 8, highfreq_factor: int = 4) -> int:
    img_size = hash_size * highfreq_factor
    with Image.open(path) as img:
        gray = img.convert("L").resize((img_size, img_size), Image.Resampling.LANCZOS)
        pixels = np.asarray(gray, dtype=np.float64)

    dct = _cached_dct_matrix(img_size)
    transformed = dct @ pixels @ dct.T
    low_freq = transformed[:hash_size, :hash_size].copy()
    coefficients = low_freq.flatten()
    median = np.median(coefficients[1:])

    value = 0
    for index, coefficient in enumerate(coefficients):
        if coefficient > median:
            value |= 1 << index
    return value


def hamming_distance(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def extract_metadata(row: Any, path: str) -> dict:
    metadata = {
        "width": 0,
        "height": 0,
        "pixels": 0,
        "fileSize": row["size"],
        "takenAt": None,
        "hasGps": False,
    }
    try:
        with Image.open(path) as img:
            metadata["width"], metadata["height"] = img.size
            metadata["pixels"] = img.size[0] * img.size[1]
            exif = img.getexif()
            if exif:
                tag_map = {ExifTags.TAGS.get(key, key): value for key, value in exif.items()}
                metadata["takenAt"] = tag_map.get("DateTimeOriginal") or tag_map.get("DateTime")
                metadata["hasGps"] = "GPSInfo" in tag_map
    except OSError:
        pass
    return metadata


def quality_score(row: Any) -> float:
    if row["manual_score"] is not None:
        return float(row["manual_score"])
    if row["score"] is not None:
        return float(row["score"])
    return 0.0


def clear_similarity_cache() -> None:
    with _result_cache_lock:
        _result_cache.clear()


def _candidate_rows(workspace_id: str | None = None, folder_path: str | None = None) -> list[Any]:
    rows = []
    for row in db.list_photos(workspace_id):
        if folder_path is not None and row["folder_path"] != folder_path:
            continue
        if not os.path.exists(storage.resolve_disk_path(row["path"])):
            continue
        rows.append(row)
    return rows


def _rows_signature(rows: list[Any]) -> tuple:
    return tuple(
        (
            row["id"],
            row["path"],
            row["content_hash"],
            row["mtime"],
            row["size"],
            row["score"],
            row["manual_score"],
            row["orientation_override"],
            row["status"],
        )
        for row in rows
    )


def _signature_digest(signature: tuple) -> str:
    payload = json.dumps(signature, separators=(",", ":"), sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _cache_get(key: tuple) -> dict | None:
    with _result_cache_lock:
        cached = _result_cache.get(key)
    return copy.deepcopy(cached) if cached is not None else None


def _cache_set(key: tuple, payload: dict) -> None:
    with _result_cache_lock:
        if len(_result_cache) >= SIMILARITY_CACHE_MAX_ITEMS:
            oldest_key = next(iter(_result_cache))
            _result_cache.pop(oldest_key, None)
        _result_cache[key] = copy.deepcopy(payload)


def _stages_payload(clip_status: str) -> dict:
    return {
        "phash": {
            "exactDistance": PHASH_EXACT_DISTANCE,
            "reviewDistance": PHASH_REVIEW_DISTANCE,
        },
        "clip": {
            "status": clip_status,
            "similarity": CLIP_HIGH_SIMILARITY,
            "reviewSimilarity": CLIP_REVIEW_SIMILARITY,
        },
    }


def _with_cache_info(payload: dict, hit: bool, source: str) -> dict:
    next_payload = copy.deepcopy(payload)
    next_payload["cache"] = {"hit": hit, "source": source}
    return next_payload


def best_version_key(candidate: PhotoCandidate) -> tuple:
    metadata = candidate.metadata
    return (
        quality_score(candidate.row),
        metadata["pixels"],
        metadata["fileSize"],
        1 if metadata["hasGps"] else 0,
        1 if metadata["takenAt"] else 0,
        -candidate.row["mtime"],
        candidate.row["name"],
    )


def load_candidates(
    workspace_id: str | None = None,
    folder_path: str | None = None,
    rows: list[Any] | None = None,
) -> list[PhotoCandidate]:
    candidates = []
    for row in rows if rows is not None else _candidate_rows(workspace_id, folder_path):
        path = storage.resolve_disk_path(row["path"])
        try:
            display_path = storage.display_path_for_photo_row(row)
            candidates.append(
                PhotoCandidate(
                    row=row,
                    path=display_path,
                    metadata=extract_metadata(row, display_path),
                    phash=perceptual_hash(display_path),
                )
            )
        except (OSError, storage.InvalidImageError):
            continue
    return candidates


class DisjointSet:
    def __init__(self, ids: list[str]):
        self.parent = {item_id: item_id for item_id in ids}

    def find(self, item_id: str) -> str:
        parent = self.parent[item_id]
        if parent != item_id:
            self.parent[item_id] = self.find(parent)
        return self.parent[item_id]

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def phash_matches(candidates: list[PhotoCandidate]) -> list[dict]:
    matches = []
    for left_index, left in enumerate(candidates):
        for right in candidates[left_index + 1:]:
            distance = hamming_distance(left.phash, right.phash)
            if distance <= PHASH_REVIEW_DISTANCE:
                matches.append(
                    {
                        "left": left.row["id"],
                        "right": right.row["id"],
                        "method": "phash",
                        "distance": distance,
                        "tier": "duplicate" if distance <= PHASH_EXACT_DISTANCE else "review",
                    }
                )
    return matches


CLIP_MISSING = "needs the AI runtime (Settings > Install AI Runtime)"


def clip_available() -> bool:
    return importlib.util.find_spec("open_clip") is not None


@lru_cache(maxsize=1)
def _load_clip_model():
    if not clip_available():
        return None, None, CLIP_MISSING

    import open_clip
    import torch

    model_name = os.getenv("CLIP_MODEL", "ViT-B-32")
    pretrained = os.getenv("CLIP_PRETRAINED", "laion2b_s34b_b79k")
    model, _unused_train, preprocess = open_clip.create_model_and_transforms(model_name, pretrained=pretrained)
    model.eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = model.to(device)
    return model, preprocess, device


def _top_neighbors_numpy(vectors: np.ndarray, limit: int) -> tuple[np.ndarray, np.ndarray, str]:
    scores = vectors @ vectors.T
    indices = np.argsort(-scores, axis=1)[:, :limit]
    sorted_scores = np.take_along_axis(scores, indices, axis=1)
    return sorted_scores, indices, "ready:numpy"


def _top_neighbors_faiss(vectors: np.ndarray, limit: int) -> tuple[np.ndarray, np.ndarray, str]:
    if importlib.util.find_spec("faiss") is None:
        return _top_neighbors_numpy(vectors, limit)
    import faiss

    index = faiss.IndexFlatIP(vectors.shape[1])
    index.add(vectors)
    scores, indices = index.search(vectors, limit)
    return scores, indices, "ready:faiss"


def _top_neighbors(vectors: np.ndarray, limit: int) -> tuple[np.ndarray, np.ndarray, str]:
    index_backend = os.getenv("SIMILARITY_INDEX", "numpy").lower()
    if index_backend == "faiss":
        return _top_neighbors_faiss(vectors, limit)
    return _top_neighbors_numpy(vectors, limit)


def clip_matches(candidates: list[PhotoCandidate], threshold: float = CLIP_REVIEW_SIMILARITY) -> tuple[list[dict], str]:
    try:
        loaded = _load_clip_model()
    except Exception as exc:
        return [], f"unavailable: {exc}"

    if loaded[0] is None:
        return [], f"unavailable: {loaded[2]}"

    try:
        import torch

        model, preprocess, device = loaded
        tensors = []
        valid_candidates = []
        for candidate in candidates:
            try:
                with Image.open(candidate.path) as img:
                    tensors.append(preprocess(img.convert("RGB")))
                    valid_candidates.append(candidate)
            except OSError:
                continue

        if len(tensors) < 2:
            return [], "ready"

        with torch.no_grad():
            batch = torch.stack(tensors).to(device)
            features = model.encode_image(batch)
            features = features / features.norm(dim=-1, keepdim=True)
            vectors = features.cpu().numpy().astype("float32")

        scores, indices, index_status = _top_neighbors(vectors, min(len(valid_candidates), 16))

        matches = []
        seen_pairs = set()
        for row_index, row_scores in enumerate(scores):
            for score, match_index in zip(row_scores[1:], indices[row_index][1:]):
                if match_index < 0 or float(score) < threshold:
                    continue
                left = valid_candidates[row_index].row["id"]
                right = valid_candidates[int(match_index)].row["id"]
                pair = tuple(sorted((left, right)))
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                matches.append(
                    {
                        "left": left,
                        "right": right,
                        "method": "clip",
                        "similarity": round(float(score), 4),
                        "tier": "similar" if float(score) >= CLIP_HIGH_SIMILARITY else "review",
                    }
                )
        return matches, index_status
    except Exception as exc:
        return [], f"unavailable: {exc}"


def build_groups(candidates: list[PhotoCandidate], matches: list[dict]) -> list[dict]:
    by_id = {candidate.row["id"]: candidate for candidate in candidates}
    dsu = DisjointSet(list(by_id.keys()))
    for match in matches:
        dsu.union(match["left"], match["right"])

    grouped_ids: dict[str, list[str]] = {}
    for photo_id in by_id:
        grouped_ids.setdefault(dsu.find(photo_id), []).append(photo_id)

    groups = []
    for ids in grouped_ids.values():
        if len(ids) < 2:
            continue
        group_matches = [match for match in matches if match["left"] in ids and match["right"] in ids]
        group_candidates = sorted((by_id[photo_id] for photo_id in ids), key=best_version_key, reverse=True)
        keep_photo_id = group_candidates[0].row["id"]

        methods = {match["method"] for match in group_matches}
        has_clip_similar = any(match["method"] == "clip" and match["tier"] == "similar" for match in group_matches)
        has_phash_duplicate = any(match["method"] == "phash" and match["tier"] == "duplicate" for match in group_matches)
        tier = "duplicate" if has_phash_duplicate else "similar" if has_clip_similar else "review"

        groups.append(
            {
                "id": "-".join(candidate.row["id"] for candidate in group_candidates[:2]),
                "stage": "mixed" if len(methods) > 1 else next(iter(methods), "phash"),
                "tier": tier,
                "keepPhotoId": keep_photo_id,
                "photoIds": [candidate.row["id"] for candidate in group_candidates],
                "maxDistance": max((match.get("distance", 0) for match in group_matches if match["method"] == "phash"), default=None),
                "maxSimilarity": max((match.get("similarity", 0) for match in group_matches if match["method"] == "clip"), default=None),
                "matches": group_matches,
                "candidates": [
                    {
                        "photoId": candidate.row["id"],
                        "deleteRecommended": candidate.row["id"] != keep_photo_id,
                        "qualityScore": round(quality_score(candidate.row), 2),
                        "metadata": candidate.metadata,
                    }
                    for candidate in group_candidates
                ],
            }
        )

    groups.sort(key=lambda group: (
        {"duplicate": 0, "similar": 1, "review": 2}[group["tier"]],
        -len(group["photoIds"]),
        group["id"],
    ))
    return groups


def find_similar_groups(
    include_clip: bool = True,
    folder_path: str | None = None,
    workspace_id: str | None = None,
    cache_only: bool = False,
) -> dict:
    rows = _candidate_rows(workspace_id=workspace_id, folder_path=folder_path)
    rows_signature = _rows_signature(rows)
    # Groups found without CLIP must not be served once the AI runtime is installed (or vice versa),
    # so whether CLIP can run is part of the cache identity.
    use_clip = bool(include_clip) and clip_available()
    signature = _signature_digest((
        "similar-v2",
        bool(include_clip),
        use_clip,
        PHASH_EXACT_DISTANCE,
        PHASH_REVIEW_DISTANCE,
        CLIP_HIGH_SIMILARITY,
        CLIP_REVIEW_SIMILARITY,
        rows_signature,
    ))
    cache_key = (
        "similar-v2",
        workspace_id,
        folder_path,
        bool(include_clip),
        use_clip,
        signature,
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return _with_cache_info(cached, True, "memory")
    if workspace_id:
        cached = db.fetch_similarity_group_cache(workspace_id, folder_path, include_clip, signature)
        if cached is not None:
            _cache_set(cache_key, cached)
            return _with_cache_info(cached, True, "persistent")
    if cache_only:
        return {
            "groups": [],
            "stages": _stages_payload("cached:miss"),
            "cache": {"hit": False, "source": "none"},
        }

    candidates = load_candidates(workspace_id=workspace_id, folder_path=folder_path, rows=rows)
    matches = phash_matches(candidates)
    clip_status = "skipped"
    if include_clip:
        clip_found, clip_status = clip_matches(candidates)
        matches.extend(clip_found)

    payload = {
        "groups": build_groups(candidates, matches),
        "stages": _stages_payload(clip_status),
    }
    # CLIP is installed but failed to load (e.g. a missing system DLL): keep the result out of the
    # caches so the next scan tries CLIP again instead of replaying the failure.
    if use_clip and clip_status.startswith("unavailable"):
        _load_clip_model.cache_clear()
        return _with_cache_info(payload, False, "computed")
    _cache_set(cache_key, payload)
    if workspace_id:
        db.save_similarity_group_cache(workspace_id, folder_path, include_clip, signature, payload)
    return _with_cache_info(payload, False, "computed")

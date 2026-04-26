from __future__ import annotations

import os

from PIL import Image

from . import db, storage


def perceptual_hash(path: str, hash_size: int = 8) -> int:
    with Image.open(path) as img:
        gray = img.convert("L").resize((hash_size + 1, hash_size), Image.Resampling.LANCZOS)
        pixels = list(gray.tobytes())
    value = 0
    bit = 0
    row_width = hash_size + 1
    for y in range(hash_size):
        row_start = y * row_width
        for x in range(hash_size):
            if pixels[row_start + x] > pixels[row_start + x + 1]:
                value |= 1 << bit
            bit += 1
    return value


def hamming_distance(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def find_similar_groups(threshold: int = 6) -> list[dict]:
    threshold = max(0, min(64, int(threshold)))
    hashed = []
    for row in db.list_photos():
        path = storage.resolve_disk_path(row["path"])
        if not os.path.exists(path):
            continue
        try:
            hashed.append({"row": row, "hash": perceptual_hash(path)})
        except OSError:
            continue

    groups = []
    visited: set[str] = set()
    for item in hashed:
        photo_id = item["row"]["id"]
        if photo_id in visited:
            continue

        group = [item]
        visited.add(photo_id)
        max_distance = 0

        for candidate in hashed:
            candidate_id = candidate["row"]["id"]
            if candidate_id in visited:
                continue
            distance = min(hamming_distance(candidate["hash"], group_item["hash"]) for group_item in group)
            if distance <= threshold:
                group.append(candidate)
                visited.add(candidate_id)
                max_distance = max(max_distance, distance)

        if len(group) > 1:
            group.sort(key=lambda group_item: (
                group_item["row"]["folder_path"],
                group_item["row"]["name"],
            ))
            groups.append(
                {
                    "id": "-".join(group_item["row"]["id"] for group_item in group[:2]),
                    "photoIds": [group_item["row"]["id"] for group_item in group],
                    "maxDistance": max_distance,
                }
            )

    groups.sort(key=lambda group: (-len(group["photoIds"]), group["id"]))
    return groups

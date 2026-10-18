import numpy as np
import pytest
from PIL import Image

from server import db, editing, export_enhance, storage
from server.config import AppConfig


@pytest.fixture()
def photos(tmp_path):
    config = AppConfig(upload_folder=str(tmp_path / "uploads"), db_path=str(tmp_path / "data" / "t.db"))
    db.configure(config)
    storage.configure(config)
    db.init_db()
    export_enhance.queue = export_enhance.JobQueue()  # fresh caches per test
    source = tmp_path / "src"
    source.mkdir()
    ramp = np.linspace(0, 1, 64, dtype=np.float32)[None, :, None]

    def save(name, gain, offset=0.0):
        pixels = np.clip(ramp * gain + offset, 0, 1).repeat(48, axis=0).repeat(3, axis=2)
        Image.fromarray((pixels * 255).astype(np.uint8)).save(source / name, quality=95)

    save("ref.jpg", 0.8)
    save("dark.jpg", 0.62)  # about 0.8 EV darker, inside the 1 EV cap
    save("night.jpg", 0.12)
    save("same.jpg", 0.8)
    save("very_dark.jpg", 0.14, 0.1)
    workspace = storage.create_workspace(str(source))
    storage.wait_for_scan(workspace["id"])
    return {row["name"]: row["id"] for row in db.list_photos(workspace["id"])}


def plan(photos, *names):
    v2 = export_enhance.parse_settings({"recipeVersion": 2})
    result = export_enhance.match_exposure(photos["ref.jpg"], v2, {photos[n]: v2 for n in names})
    return {r["name"]: r for r in result["results"]}


def test_darker_photo_is_brightened_to_the_reference(photos):
    result = plan(photos, "dark.jpg", "same.jpg")
    dark = result["dark.jpg"]
    assert dark["status"] == "adjust" and 0.3 < dark["deltaEv"] <= 1.0
    row = db.fetch_photo(photos["dark.jpg"])
    v2 = export_enhance.parse_settings({"recipeVersion": 2, "exposure": dark["proposed"]})
    ref = export_enhance.parse_settings({"recipeVersion": 2})
    after = editing.luminance_stats(export_enhance._render_for_stats(row, v2))["median"]
    target = editing.luminance_stats(export_enhance._render_for_stats(db.fetch_photo(photos["ref.jpg"]), ref))["median"]
    assert abs(after - target) < 0.03
    assert result["same.jpg"]["status"] == "unchanged"


def test_night_scene_is_not_forced_to_daylight(photos):
    assert plan(photos, "night.jpg")["night.jpg"]["status"] == "skip"


def test_changes_are_capped(photos):
    very_dark = plan(photos, "very_dark.jpg")["very_dark.jpg"]
    assert very_dark["status"] == "adjust" and very_dark["deltaEv"] <= export_enhance.MATCH_LIMIT_EV and very_dark["limited"]


def test_scene_kinds():
    assert editing.scene_kind({"median": 0.05, "high": 0.4}) == "night"
    assert editing.scene_kind({"median": 0.15, "high": 0.95}) == "silhouette"
    assert editing.scene_kind({"median": 0.4, "high": 0.9}) == "normal"

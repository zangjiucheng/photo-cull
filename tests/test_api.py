from pathlib import Path
import threading
from types import SimpleNamespace
from zipfile import ZipFile

import pytest
from PIL import Image

from server import create_app
from server import db, raw_pipeline, similarity, storage
from server.config import AppConfig


@pytest.fixture()
def client(tmp_path, monkeypatch):
    config = AppConfig(upload_folder=str(tmp_path / "uploads"), db_path=str(tmp_path / "data" / "test.db"))
    app = create_app(config)
    app.config.update(TESTING=True)
    monkeypatch.setattr("server.scoring.enqueue_scoring", lambda _photo_id, _path: None)
    return app.test_client()


def make_image(path: Path, color: str = "blue") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color).save(path)
    return path


def fake_rawpy(monkeypatch):
    from io import BytesIO

    thumb_buffer = BytesIO()
    Image.new("RGB", (12, 8), "green").save(thumb_buffer, format="JPEG")

    class FakeRaw:
        def __enter__(self):
            return self

        def __exit__(self, _exc_type, _exc, _traceback):
            return False

        def extract_thumb(self):
            return SimpleNamespace(format="jpeg", data=thumb_buffer.getvalue())

        def postprocess(self, **_kwargs):
            raise AssertionError("embedded thumbnail should be preferred")

    module = SimpleNamespace(
        ThumbFormat=SimpleNamespace(JPEG="jpeg", BITMAP="bitmap"),
        imread=lambda _path: FakeRaw(),
    )
    monkeypatch.setattr(raw_pipeline.importlib.util, "find_spec", lambda name: object() if name == "rawpy" else None)
    monkeypatch.setattr(raw_pipeline.importlib, "import_module", lambda name: module if name == "rawpy" else __import__(name))
    return module


def open_workspace(client, root: Path):
    response = client.post("/api/workspaces", json={"root_path": str(root)})
    assert response.status_code == 200
    workspace = response.get_json()
    storage.wait_for_scan(workspace["id"])
    return workspace


def open_workspace_without_wait(client, root: Path):
    response = client.post("/api/workspaces", json={"root_path": str(root)})
    assert response.status_code == 200
    return response.get_json()


def test_health_and_empty_library(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.get_json()["ok"] is True

    library = client.get("/api/library")
    assert library.status_code == 200
    payload = library.get_json()
    assert payload["photos"] == []
    assert payload["workspaces"] == []


def test_open_workspace_scans_external_folder_without_copying(client, tmp_path):
    source = tmp_path / "source"
    make_image(source / "set" / "sample.jpg")

    workspace = open_workspace(client, source)
    library = client.get(f"/api/library?workspace_id={workspace['id']}")

    assert library.status_code == 200
    payload = library.get_json()
    assert payload["activeWorkspace"]["rootPath"] == str(source)
    assert len(payload["photos"]) == 1
    photo = payload["photos"][0]
    assert photo["relativePath"] == "set/sample.jpg"
    assert Path(photo["path"]) == source / "set" / "sample.jpg"
    assert not list((tmp_path / "uploads").glob("*.jpg"))


def test_open_workspace_returns_before_background_scan_finishes(client, tmp_path, monkeypatch):
    source = tmp_path / "source"
    make_image(source / "sample.jpg")
    scan_started = threading.Event()
    release_scan = threading.Event()

    def deferred_scan(*args, **kwargs):
        scan_started.set()
        release_scan.wait(timeout=2)

    monkeypatch.setattr(storage, "scan_workspace", deferred_scan)
    workspace = open_workspace_without_wait(client, source)
    library = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()

    assert library["activeWorkspace"]["id"] == workspace["id"]
    assert library["summary"]["indexing"]["active"] is True
    assert scan_started.wait(timeout=1)
    release_scan.set()
    storage.wait_for_scan(workspace["id"])


def test_library_does_not_auto_select_workspace(client, tmp_path):
    source = tmp_path / "source"
    make_image(source / "sample.jpg")
    workspace = open_workspace(client, source)

    landing_library = client.get("/api/library")
    assert landing_library.status_code == 200
    landing_payload = landing_library.get_json()
    assert landing_payload["activeWorkspace"] is None
    assert landing_payload["workspaces"][0]["id"] == workspace["id"]
    assert landing_payload["photos"] == []

    selected_library = client.get(f"/api/library?workspace_id={workspace['id']}")
    assert selected_library.status_code == 200
    assert selected_library.get_json()["activeWorkspace"]["id"] == workspace["id"]
    assert len(selected_library.get_json()["photos"]) == 1


def test_rating_score_image_and_export(client, tmp_path):
    source = tmp_path / "source"
    make_image(source / "sample.jpg")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]

    image = client.get(f"/api/photos/{photo['id']}/image")
    assert image.status_code == 200
    assert image.headers["Content-Type"].startswith("image/")

    rating = client.patch(f"/api/photos/{photo['id']}/rating", json={"rating": 5})
    assert rating.status_code == 200
    assert rating.get_json()["rating"] == 5

    score = client.patch(f"/api/photos/{photo['id']}/score", json={"manual_score": 88})
    assert score.status_code == 200
    assert score.get_json()["manualScore"] == 88

    orientation = client.patch(f"/api/photos/{photo['id']}/orientation", json={"orientation_override": 90})
    assert orientation.status_code == 200
    assert orientation.get_json()["orientationOverride"] == 90
    assert "?v=" in orientation.get_json()["url"]

    export = client.post("/api/photos/export", json={"selected_ids": [photo["id"]]})
    assert export.status_code == 200
    assert export.headers["Content-Type"].startswith("application/zip")


def test_dng_preview_uses_cached_jpeg_and_export_keeps_original(client, tmp_path, monkeypatch):
    fake_rawpy(monkeypatch)
    source = tmp_path / "source"
    dng_path = source / "sample.dng"
    dng_path.parent.mkdir()
    dng_path.write_bytes(b"fake-dng")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]

    image = client.get(f"/api/photos/{photo['id']}/image")
    assert image.status_code == 200
    assert image.headers["Content-Type"].startswith("image/jpeg")

    export = client.post("/api/photos/export", json={"selected_ids": [photo["id"]]})
    assert export.status_code == 200
    archive_path = tmp_path / "selected.zip"
    archive_path.write_bytes(export.data)
    with ZipFile(archive_path) as zip_file:
        assert zip_file.namelist() == ["sample.dng"]
        assert zip_file.read("sample.dng") == b"fake-dng"


def test_delete_workspace_clears_similarity_and_render_caches(client, tmp_path, monkeypatch):
    fake_rawpy(monkeypatch)
    source = tmp_path / "source"
    source.mkdir()
    (source / "a.dng").write_bytes(b"fake-dng-a")
    (source / "b.dng").write_bytes(b"fake-dng-b")
    workspace = open_workspace(client, source)
    photos = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"]

    for photo in photos:
        image = client.get(f"/api/photos/{photo['id']}/image")
        assert image.status_code == 200
        image.close()  # release the file handle, which Windows would otherwise keep locked
    assert list(Path(db.get_config().render_cache_folder).glob("*.jpg"))

    similar = client.get(f"/api/photos/similar?workspace_id={workspace['id']}&include_clip=0&scope=library")
    assert similar.status_code == 200
    assert similar.get_json()["cache"] == {"hit": False, "source": "computed"}
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM similarity_group_cache WHERE workspace_id = ?", (workspace["id"],)).fetchone()[0] == 1

    delete = client.delete(f"/api/workspaces/{workspace['id']}")
    assert delete.status_code == 200
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM photos WHERE workspace_id = ?", (workspace["id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM similarity_group_cache WHERE workspace_id = ?", (workspace["id"],)).fetchone()[0] == 0
    assert not list(Path(db.get_config().render_cache_folder).glob("*.jpg"))

    recreated = open_workspace(client, source)
    cache_only = client.get(f"/api/photos/similar?workspace_id={recreated['id']}&include_clip=0&scope=library&cache_only=1")
    assert cache_only.status_code == 200
    assert cache_only.get_json()["cache"] == {"hit": False, "source": "none"}


def test_multiple_workspaces_isolate_same_relative_path(client, tmp_path):
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    make_image(first_root / "same.jpg", "blue")
    make_image(second_root / "same.jpg", "red")

    first = open_workspace(client, first_root)
    second = open_workspace(client, second_root)
    first_photo = client.get(f"/api/library?workspace_id={first['id']}").get_json()["photos"][0]
    second_photo = client.get(f"/api/library?workspace_id={second['id']}").get_json()["photos"][0]

    assert first_photo["id"] != second_photo["id"]
    assert first_photo["workspaceId"] == first["id"]
    assert second_photo["workspaceId"] == second["id"]


def test_refresh_detects_new_and_missing_files(client, tmp_path):
    source = tmp_path / "source"
    first_path = make_image(source / "first.jpg")
    workspace = open_workspace(client, source)

    make_image(source / "second.jpg")
    refresh = client.post(f"/api/workspaces/{workspace['id']}/refresh")
    assert refresh.status_code == 200
    storage.wait_for_scan(workspace["id"])
    assert len(client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"]) == 2

    first_path.unlink()
    refresh_missing = client.post(f"/api/workspaces/{workspace['id']}/refresh")
    assert refresh_missing.status_code == 200
    storage.wait_for_scan(workspace["id"])
    names = {photo["name"] for photo in client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"]}
    assert names == {"second.jpg"}


def test_refresh_preserves_photo_state_after_move(client, tmp_path):
    source = tmp_path / "source"
    first_path = make_image(source / "set" / "sample.jpg")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]

    rating = client.patch(f"/api/photos/{photo['id']}/rating", json={"rating": 4})
    assert rating.status_code == 200
    score = client.patch(f"/api/photos/{photo['id']}/score", json={"manual_score": 91})
    assert score.status_code == 200

    moved_path = source / "renamed" / "sample.jpg"
    moved_path.parent.mkdir()
    first_path.rename(moved_path)

    refresh = client.post(f"/api/workspaces/{workspace['id']}/refresh")
    assert refresh.status_code == 200
    storage.wait_for_scan(workspace["id"])
    photos = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"]
    assert len(photos) == 1
    moved = photos[0]
    assert moved["relativePath"] == "renamed/sample.jpg"
    assert moved["path"] == str(moved_path)
    assert moved["rating"] == 4
    assert moved["manualScore"] == 91
    assert moved["id"] != photo["id"]


def test_refresh_preserves_score_details_after_move(client, tmp_path):
    source = tmp_path / "source"
    first_path = make_image(source / "set" / "sample.jpg")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]
    db.mark_done(photo["id"], 76, {"mode": "test", "metrics": {"fake": {"raw": 1}}})

    moved_path = source / "renamed" / "sample.jpg"
    moved_path.parent.mkdir()
    first_path.rename(moved_path)

    refresh = client.post(f"/api/workspaces/{workspace['id']}/refresh")
    assert refresh.status_code == 200
    storage.wait_for_scan(workspace["id"])
    moved = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]
    row = db.fetch_photo(moved["id"])
    assert row["score"] == 76
    assert moved["scoreDetails"]["mode"] == "test"
    assert moved["scoreDetails"]["metrics"]["fake"]["raw"] == 1
    assert '"mode": "test"' in row["score_details"]


def test_refresh_preserves_dng_state_after_move(client, tmp_path, monkeypatch):
    fake_rawpy(monkeypatch)
    source = tmp_path / "source"
    first_path = source / "set" / "sample.dng"
    first_path.parent.mkdir(parents=True)
    first_path.write_bytes(b"fake-dng")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]
    db.mark_done(photo["id"], 77, {"mode": "dng"})

    moved_path = source / "renamed" / "sample.dng"
    moved_path.parent.mkdir()
    first_path.rename(moved_path)

    refresh = client.post(f"/api/workspaces/{workspace['id']}/refresh")
    assert refresh.status_code == 200
    storage.wait_for_scan(workspace["id"])
    moved = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]
    assert moved["relativePath"] == "renamed/sample.dng"
    row = db.fetch_photo(moved["id"])
    assert row["score"] == 77
    assert '"mode": "dng"' in row["score_details"]


def test_rescore_workspace_resets_auto_scores_and_preserves_manual_state(client, tmp_path, monkeypatch):
    source = tmp_path / "source"
    make_image(source / "sample.jpg")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]
    db.mark_done(photo["id"], 76, {"mode": "old"})
    client.patch(f"/api/photos/{photo['id']}/rating", json={"rating": 5})
    client.patch(f"/api/photos/{photo['id']}/score", json={"manual_score": 91})
    queued = []
    monkeypatch.setattr("server.scoring.enqueue_scoring", lambda photo_id, path: queued.append((photo_id, path)))

    response = client.post(f"/api/workspaces/{workspace['id']}/rescore")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["rescore"]["queued"] == 1
    assert payload["summary"]["pending"] == 1
    assert queued == [(photo["id"], str(source / "sample.jpg"))]
    refreshed = payload["photos"][0]
    assert refreshed["score"] is None
    assert refreshed["manualScore"] == 91
    assert refreshed["rating"] == 5
    row = db.fetch_photo(photo["id"])
    assert row["score_details"] is None


def test_refresh_keeps_moved_removed_photo_hidden(client, tmp_path):
    source = tmp_path / "source"
    first_path = make_image(source / "set" / "sample.jpg")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]

    delete = client.delete("/api/photos", json={"photo_ids": [photo["id"]]})
    assert delete.status_code == 200

    moved_path = source / "renamed" / "sample.jpg"
    moved_path.parent.mkdir()
    first_path.rename(moved_path)

    refresh = client.post(f"/api/workspaces/{workspace['id']}/refresh")
    assert refresh.status_code == 200
    storage.wait_for_scan(workspace["id"])
    payload = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()
    assert payload["photos"] == []
    assert payload["summary"]["excluded"] == 1


def test_remove_keeps_source_file_hidden_and_restore_returns_it(client, tmp_path):
    source = tmp_path / "source"
    image_path = make_image(source / "sample.jpg")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]

    delete = client.delete("/api/photos", json={"photo_ids": [photo["id"]]})
    assert delete.status_code == 200
    assert delete.get_json()["deletedRecords"] == 1
    assert image_path.exists()

    refresh = client.post(f"/api/workspaces/{workspace['id']}/refresh")
    assert refresh.status_code == 200
    storage.wait_for_scan(workspace["id"])
    refreshed = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()
    assert refreshed["photos"] == []
    assert refreshed["summary"]["excluded"] == 1

    restore = client.post("/api/photos/restore", json={"workspace_id": workspace["id"]})
    assert restore.status_code == 200
    assert restore.get_json()["restored"] == 1
    storage.wait_for_scan(workspace["id"])

    library = client.get(f"/api/library?workspace_id={workspace['id']}")
    assert len(library.get_json()["photos"]) == 1


def test_similar_detection_uses_workspace_scope(client, tmp_path):
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    make_image(first_root / "a.jpg", "blue")
    make_image(first_root / "b.jpg", "blue")
    make_image(second_root / "a.jpg", "blue")

    first = open_workspace(client, first_root)
    second = open_workspace(client, second_root)

    similar = client.get(f"/api/photos/similar?workspace_id={first['id']}&include_clip=0&scope=current&folder_path=")
    assert similar.status_code == 200
    payload = similar.get_json()
    assert payload["stages"]["phash"]["exactDistance"] == 5
    assert payload["groups"]
    assert all(len(group["photoIds"]) == 2 for group in payload["groups"])

    second_similar = client.get(f"/api/photos/similar?workspace_id={second['id']}&include_clip=0&scope=library")
    assert second_similar.status_code == 200
    assert second_similar.get_json()["groups"] == []

    invalid_scope = client.get(f"/api/photos/similar?workspace_id={first['id']}&scope=bad")
    assert invalid_scope.status_code == 400


def test_similarity_uses_cached_display_image_for_dng(client, tmp_path, monkeypatch):
    fake_rawpy(monkeypatch)
    source = tmp_path / "source"
    source.mkdir()
    (source / "a.dng").write_bytes(b"fake-dng-a")
    (source / "b.dng").write_bytes(b"fake-dng-b")
    workspace = open_workspace(client, source)

    similar = client.get(f"/api/photos/similar?workspace_id={workspace['id']}&include_clip=0&scope=library")

    assert similar.status_code == 200
    assert similar.get_json()["groups"]


def test_similar_detection_reuses_cached_result(client, tmp_path, monkeypatch):
    source = tmp_path / "source"
    make_image(source / "a.jpg", "blue")
    make_image(source / "b.jpg", "blue")
    workspace = open_workspace(client, source)
    similarity.clear_similarity_cache()

    calls = {"count": 0}
    original_hash = similarity.perceptual_hash

    def counted_hash(path, *args, **kwargs):
        calls["count"] += 1
        return original_hash(path, *args, **kwargs)

    monkeypatch.setattr(similarity, "perceptual_hash", counted_hash)

    first = client.get(f"/api/photos/similar?workspace_id={workspace['id']}&include_clip=0&scope=library")
    second = client.get(f"/api/photos/similar?workspace_id={workspace['id']}&include_clip=0&scope=library")

    assert first.status_code == 200
    assert second.status_code == 200
    first_payload = first.get_json()
    second_payload = second.get_json()
    assert first_payload["groups"] == second_payload["groups"]
    assert first_payload["stages"] == second_payload["stages"]
    assert first_payload["cache"] == {"hit": False, "source": "computed"}
    assert second_payload["cache"] == {"hit": True, "source": "memory"}
    assert calls["count"] == 2

    similarity.clear_similarity_cache()
    third = client.get(f"/api/photos/similar?workspace_id={workspace['id']}&include_clip=0&scope=library")

    third_payload = third.get_json()
    assert third.status_code == 200
    assert third_payload["groups"] == first_payload["groups"]
    assert third_payload["stages"] == first_payload["stages"]
    assert third_payload["cache"] == {"hit": True, "source": "persistent"}
    assert calls["count"] == 2

    cache_only = client.get(f"/api/photos/similar?workspace_id={workspace['id']}&include_clip=0&scope=library&cache_only=1")
    cache_only_payload = cache_only.get_json()

    assert cache_only.status_code == 200
    assert cache_only_payload["groups"] == first_payload["groups"]
    assert cache_only_payload["cache"]["hit"] is True
    assert calls["count"] == 2


def test_invalid_score_and_missing_photo(client):
    bad_score = client.patch("/api/photos/missing/score", json={"manual_score": 120})
    assert bad_score.status_code == 400

    missing = client.patch("/api/photos/missing/rating", json={"rating": 5})
    assert missing.status_code == 404

    invalid_rating = client.patch("/api/photos/missing/rating", json={"rating": 6})
    assert invalid_rating.status_code == 400


def test_empty_export_rejected(client):
    response = client.post("/api/photos/export", json={"selected_ids": []})
    assert response.status_code == 400


def test_export_enhance_api_validates_request(client, tmp_path):
    missing_selection = client.post("/api/export-enhance/jobs", json={"selected_ids": [], "output_folder": str(tmp_path)})
    assert missing_selection.status_code == 400

    bad_folder = client.post("/api/export-enhance/jobs", json={"selected_ids": ["missing"], "output_folder": str(tmp_path / "missing")})
    assert bad_folder.status_code == 400


def test_export_enhance_api_creates_color_only_job(client, tmp_path):
    source = tmp_path / "source"
    make_image(source / "a.jpg", "blue")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]
    output = tmp_path / "out"
    output.mkdir()

    response = client.post("/api/export-enhance/jobs", json={
        "selected_ids": [photo["id"]],
        "output_folder": str(output),
        "settings": {"exposure": 0.1, "outputFormat": "jpeg", "quality": 90}
    })

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["total"] == 1
    fetched = client.get(f"/api/export-enhance/jobs/{payload['id']}")
    assert fetched.status_code == 200


def test_export_enhance_preview_renders_jpeg(client, tmp_path):
    source = tmp_path / "source"
    make_image(source / "a.jpg", "blue")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]

    response = client.post("/api/export-enhance/preview", json={
        "photo_id": photo["id"],
        "settings": {"exposure": 0.1, "outputFormat": "jpeg"}
    })

    assert response.status_code == 200
    assert response.headers["Content-Type"].startswith("image/jpeg")


def test_editing_base_is_float_source_and_invalidates_when_source_changes(client, tmp_path):
    import numpy as np
    source = tmp_path / "source"
    path = make_image(source / "a.png", "blue")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]
    response = client.get(f"/api/photos/{photo['id']}/editing-base")
    assert response.status_code == 200
    assert response.headers["X-Image-Width"] == "8"
    assert response.headers["X-Image-Height"] == "8"
    pixels = np.frombuffer(response.data, dtype="<f4").reshape(8, 8, 3)
    np.testing.assert_array_equal(pixels[0, 0], [0, 0, 1])
    make_image(path, "red")
    newer = client.get(f"/api/photos/{photo['id']}/editing-base")
    pixels = np.frombuffer(newer.data, dtype="<f4").reshape(8, 8, 3)
    np.testing.assert_array_equal(pixels[0, 0], [1, 0, 0])
    suggested = client.get(f"/api/photos/{photo['id']}/auto-adjustments")
    assert suggested.status_code == 200
    assert suggested.get_json()["temperature"] == 0
    path.unlink()
    assert client.get(f"/api/photos/{photo['id']}/editing-base").status_code == 400


def test_invalid_recipe_payload_returns_actionable_error(client, tmp_path):
    source = tmp_path / "source"
    make_image(source / "a.png")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]
    response = client.post("/api/export-enhance/preview", json={"photo_id": photo["id"], "settings": {"quality": []}})
    assert response.status_code == 400
    assert "Invalid" in response.get_json()["error"]


def test_detail_endpoint_and_new_recipe_fields_persist(client, tmp_path):
    import numpy as np
    source = tmp_path / "source"
    make_image(source / "a.png", "blue")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]
    settings = {"recipeVersion": 2, "engineVersion": 1, "rawProfileVersion": 1,
        "gradient": {"exposure": -.5}, "selectedColor": {"center": 2 / 3, "luminance": -.3}}
    saved = client.put(f"/api/workspaces/{workspace['id']}/export-enhance-settings", json={"settings_by_photo": {photo["id"]: settings}})
    assert saved.status_code == 200
    loaded = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["exportEnhanceSettings"][photo["id"]]
    assert loaded["engineVersion"] == loaded["rawProfileVersion"] == 1
    assert loaded["gradient"]["exposure"] == -.5 and loaded["selectedColor"]["luminance"] == -.3
    base = client.get(f"/api/photos/{photo['id']}/editing-base")
    assert base.headers["X-Source-Width"] == base.headers["X-Source-Height"] == "8"
    payload = {"settings": loaded, "region": {"x": 2, "y": 3, "width": 4, "height": 3}}
    detail = client.post(f"/api/photos/{photo['id']}/editing-detail", json=payload)
    assert detail.status_code == 200
    assert detail.headers["X-Image-Width"] == "4" and detail.headers["X-Image-Height"] == "3"
    assert detail.headers["X-Region-X"] == "2" and detail.headers["Cache-Control"] == "no-store"
    assert np.frombuffer(detail.data, dtype="<f4").size == 4 * 3 * 3
    assert client.post(f"/api/photos/{photo['id']}/editing-detail", json={**payload, "region": {}}).status_code == 400
    rejected = client.put(f"/api/workspaces/{workspace['id']}/export-enhance-settings", json={"settings_by_photo": {photo["id"]: {**settings, "engineVersion": 2}}})
    assert rejected.status_code == 400
    still_saved = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["exportEnhanceSettings"][photo["id"]]
    assert still_saved == loaded


def test_export_enhance_settings_are_persistent(client, tmp_path):
    source = tmp_path / "source"
    make_image(source / "a.jpg", "blue")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]

    saved = client.put(f"/api/workspaces/{workspace['id']}/export-enhance-settings", json={
        "settings_by_photo": {
            photo["id"]: {
                "photoStyle": {"preset": "warm", "tone": 24, "colour": 12, "palette": 70},
                "aiDenoise": True,
                "aiDenoiseStrength": "low",
                "outputFormat": "jpeg",
            }
        }
    })

    assert saved.status_code == 200
    payload = saved.get_json()
    assert payload["settingsByPhoto"][photo["id"]]["photoStyle"]["preset"] == "warm"
    library = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()
    assert library["exportEnhanceSettings"][photo["id"]]["photoStyle"]["tone"] == 24
    assert library["exportEnhanceSettings"][photo["id"]]["aiDenoise"] is True


def test_export_deduplicates_selected_ids(client, tmp_path):
    source = tmp_path / "source"
    make_image(source / "sample.jpg")
    workspace = open_workspace(client, source)
    photo = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"][0]

    response = client.post("/api/photos/export", json={"selected_ids": [photo["id"], photo["id"]]})

    assert response.status_code == 200
    archive_path = tmp_path / "selected.zip"
    archive_path.write_bytes(response.data)
    with ZipFile(archive_path) as archive:
        assert archive.namelist() == ["sample.jpg"]


def test_export_queue_persists_for_workspace(client, tmp_path):
    source = tmp_path / "source"
    make_image(source / "a.jpg", "blue")
    make_image(source / "b.jpg", "green")
    workspace = open_workspace(client, source)
    photos = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()["photos"]

    save = client.put(f"/api/workspaces/{workspace['id']}/export-queue", json={"photo_ids": [photos[1]["id"], photos[0]["id"], photos[0]["id"]]})
    assert save.status_code == 200
    assert save.get_json()["ids"] == [photos[1]["id"], photos[0]["id"]]

    library = client.get(f"/api/library?workspace_id={workspace['id']}").get_json()
    assert library["exportQueue"] == [photos[1]["id"], photos[0]["id"]]

from pathlib import Path

import pytest
from PIL import Image

from server import create_app
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


def open_workspace(client, root: Path):
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

    export = client.post("/api/photos/export", json={"selected_ids": [photo["id"]]})
    assert export.status_code == 200
    assert export.headers["Content-Type"].startswith("application/zip")


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
    assert len(refresh.get_json()["photos"]) == 2

    first_path.unlink()
    refresh_missing = client.post(f"/api/workspaces/{workspace['id']}/refresh")
    assert refresh_missing.status_code == 200
    names = {photo["name"] for photo in refresh_missing.get_json()["photos"]}
    assert names == {"second.jpg"}


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
    assert refresh.get_json()["photos"] == []
    assert refresh.get_json()["summary"]["excluded"] == 1

    restore = client.post("/api/photos/restore", json={"workspace_id": workspace["id"]})
    assert restore.status_code == 200
    assert restore.get_json()["restored"] == 1

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

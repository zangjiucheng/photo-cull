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


def image_file(tmp_path: Path) -> Path:
    path = tmp_path / "sample.jpg"
    Image.new("RGB", (8, 8), "blue").save(path)
    return path


def upload_photo(client, tmp_path):
    path = image_file(tmp_path)
    with path.open("rb") as file_obj:
        response = client.post(
            "/api/photos/upload",
            data={"files": (file_obj, "sample.jpg")},
            content_type="multipart/form-data",
        )
    assert response.status_code == 200
    return response.get_json()[0]


def test_health_and_empty_library(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.get_json()["ok"] is True

    library = client.get("/api/library")
    assert library.status_code == 200
    assert library.get_json()["photos"] == []


def test_upload_rating_score_and_export(client, tmp_path):
    photo = upload_photo(client, tmp_path)

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


def test_similar_detection_and_delete(client, tmp_path):
    first_path = image_file(tmp_path)
    second_path = tmp_path / "sample-copy.jpg"
    Image.new("RGB", (8, 8), "blue").save(second_path)

    with first_path.open("rb") as first, second_path.open("rb") as second:
        upload = client.post(
            "/api/photos/upload",
            data={"files": [(first, "sample.jpg"), (second, "sample-copy.jpg")]},
            content_type="multipart/form-data",
        )
    assert upload.status_code == 200
    photos = upload.get_json()

    similar = client.get("/api/photos/similar?include_clip=0")
    assert similar.status_code == 200
    payload = similar.get_json()
    groups = payload["groups"]
    assert payload["stages"]["phash"]["exactDistance"] == 5
    assert any(set(group["photoIds"]) == {photo["id"] for photo in photos} for group in groups)
    assert groups[0]["keepPhotoId"] in {photo["id"] for photo in photos}

    delete = client.delete("/api/photos", json={"photo_ids": [photos[1]["id"]]})
    assert delete.status_code == 200
    assert delete.get_json()["deletedRecords"] == 1
    assert client.get(f"/api/photos/{photos[1]['id']}/image").status_code == 404


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

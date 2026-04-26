from pathlib import Path

import pytest
from PIL import Image

from server.config import AppConfig
from server import db, storage


def configure_tmp(tmp_path: Path) -> AppConfig:
    config = AppConfig(upload_folder=str(tmp_path / "uploads"), db_path=str(tmp_path / "data" / "test.db"))
    db.configure(config)
    storage.configure(config)
    db.init_db()
    return config


def make_image(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), "red").save(path)


def test_allowed_image_extensions():
    assert storage.allowed_image("frame.JPG")
    assert storage.allowed_image("frame.webp")
    assert not storage.allowed_image("frame.txt")


def test_validate_image_file_rejects_invalid_file(tmp_path):
    bad = tmp_path / "bad.jpg"
    bad.write_text("not an image")

    with pytest.raises(storage.InvalidImageError):
        storage.validate_image_file(str(bad))


def test_index_uploaded_file_inserts_and_reuses_record(tmp_path):
    config = configure_tmp(tmp_path)
    image_path = Path(config.upload_folder) / "set" / "photo.jpg"
    make_image(image_path)

    record, state = storage.index_uploaded_file(str(image_path))
    assert state == "inserted"
    assert record is not None
    assert record["folderPath"] == "set"

    record_again, state_again = storage.index_uploaded_file(str(image_path))
    assert state_again == "pending"
    assert record_again["id"] == record["id"]

from pathlib import Path

import pytest
from PIL import Image

from server.config import AppConfig, migrate_legacy_db, resolve_db_path
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


def test_index_workspace_file_inserts_and_reuses_record(tmp_path):
    config = configure_tmp(tmp_path)
    workspace_root = tmp_path / "source"
    workspace_root.mkdir()
    workspace = storage.create_workspace(str(workspace_root))
    image_path = workspace_root / "set" / "photo.jpg"
    make_image(image_path)

    record, state = storage.index_workspace_file(workspace["id"], str(image_path))
    assert state == "inserted"
    assert record is not None
    assert record["folderPath"] == "set"

    record_again, state_again = storage.index_workspace_file(workspace["id"], str(image_path))
    assert state_again == "pending"
    assert record_again["id"] == record["id"]


def test_default_db_path_uses_application_support(monkeypatch, tmp_path):
    monkeypatch.delenv("DB_PATH", raising=False)
    monkeypatch.delenv("AI_CULLING_APP_SUPPORT", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr("server.config.platform.system", lambda: "Darwin")

    assert resolve_db_path() == str(tmp_path / "Library" / "Application Support" / "AI Photo Culling" / "ai_culling.db")


def test_migrate_legacy_db_moves_repo_database(tmp_path):
    target = tmp_path / "Application Support" / "AI Photo Culling" / "ai_culling.db"
    legacy = tmp_path / "repo" / "data" / "ai_culling.db"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"legacy-db")

    moved_from = migrate_legacy_db(str(target), base_dir=tmp_path / "repo")

    assert moved_from == str(legacy)
    assert target.read_bytes() == b"legacy-db"
    assert not legacy.exists()

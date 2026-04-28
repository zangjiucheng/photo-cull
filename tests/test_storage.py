from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from server.config import AppConfig, migrate_legacy_db, resolve_db_path
from server import db, storage
from server import raw_pipeline


def configure_tmp(tmp_path: Path) -> AppConfig:
    config = AppConfig(upload_folder=str(tmp_path / "uploads"), db_path=str(tmp_path / "data" / "test.db"))
    db.configure(config)
    storage.configure(config)
    db.init_db()
    return config


def make_image(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), "red").save(path)


def fake_rawpy(monkeypatch, orientation: int | None = None):
    from io import BytesIO

    thumb_buffer = BytesIO()
    thumb = Image.new("RGB", (12, 8), "green")
    if orientation is None:
        thumb.save(thumb_buffer, format="JPEG")
    else:
        exif = Image.Exif()
        exif[274] = orientation
        thumb.save(thumb_buffer, format="JPEG", exif=exif)

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


def test_allowed_image_extensions():
    assert storage.allowed_image("frame.JPG")
    assert storage.allowed_image("frame.webp")
    assert storage.allowed_image("frame.dng")
    assert not storage.allowed_image("frame.txt")


def test_validate_image_file_rejects_invalid_file(tmp_path):
    bad = tmp_path / "bad.jpg"
    bad.write_text("not an image")

    with pytest.raises(storage.InvalidImageError):
        storage.validate_image_file(str(bad))


def test_validate_dng_file_renders_cached_display_image(tmp_path, monkeypatch):
    config = configure_tmp(tmp_path)
    fake_rawpy(monkeypatch)
    raw_path = tmp_path / "sample.dng"
    raw_path.write_bytes(b"fake-dng")

    storage.validate_image_file(str(raw_path))
    assert not list(Path(config.render_cache_folder).glob("*.jpg"))

    cached = raw_pipeline.ensure_display_image(str(raw_path))
    assert Path(cached).parent == Path(config.render_cache_folder)
    assert Path(cached).suffix == ".jpg"
    with Image.open(cached) as img:
        assert img.format == "JPEG"


def test_dng_display_image_applies_embedded_preview_orientation(tmp_path, monkeypatch):
    configure_tmp(tmp_path)
    fake_rawpy(monkeypatch, orientation=6)
    raw_path = tmp_path / "portrait.dng"
    raw_path.write_bytes(b"fake-dng")

    cached = raw_pipeline.ensure_display_image(str(raw_path))

    with Image.open(cached) as img:
        assert img.size == (8, 12)
        assert 274 not in img.getexif()


def test_validate_dng_file_fails_cleanly_without_rawpy(tmp_path, monkeypatch):
    configure_tmp(tmp_path)
    raw_path = tmp_path / "sample.dng"
    raw_path.write_bytes(b"fake-dng")
    jpg_path = tmp_path / "sample.jpg"
    make_image(jpg_path)
    monkeypatch.setattr(raw_pipeline.importlib.util, "find_spec", lambda name: None if name == "rawpy" else object())

    with pytest.raises(storage.InvalidImageError):
        storage.validate_image_file(str(raw_path))

    storage.validate_image_file(str(jpg_path))


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


def test_scan_skips_hash_for_unchanged_file(tmp_path, monkeypatch):
    configure_tmp(tmp_path)
    monkeypatch.setattr("server.scoring.enqueue_scoring", lambda _photo_id, _path: None)
    workspace_root = tmp_path / "source"
    image_path = workspace_root / "photo.jpg"
    make_image(image_path)
    workspace = storage.create_workspace(str(workspace_root))
    storage.wait_for_scan(workspace["id"])
    calls = []

    def fail_hash(path):
        calls.append(path)
        raise AssertionError("unchanged files should not be hashed")

    monkeypatch.setattr(storage, "compute_content_hash", fail_hash)

    storage.scan_workspace(workspace["id"], force_gc=True)

    assert calls == []


def test_scan_dng_queues_cached_display_image_for_scoring(tmp_path, monkeypatch):
    config = configure_tmp(tmp_path)
    fake_rawpy(monkeypatch)
    queued = []
    monkeypatch.setattr("server.scoring.enqueue_scoring", lambda photo_id, path: queued.append((photo_id, path)))
    workspace_root = tmp_path / "source"
    dng_path = workspace_root / "photo.dng"
    dng_path.parent.mkdir()
    dng_path.write_bytes(b"fake-dng")

    workspace = storage.create_workspace(str(workspace_root))
    storage.wait_for_scan(workspace["id"])

    assert workspace["id"]
    assert len(queued) == 1
    assert queued[0][1] == str(dng_path.resolve())
    assert not list(Path(config.render_cache_folder).glob("*.jpg"))


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


def test_init_db_adds_score_details_column(tmp_path):
    configure_tmp(tmp_path)

    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(photos)").fetchall()}

    assert "score_details" in columns

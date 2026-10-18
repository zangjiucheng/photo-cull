import os
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


def make_oriented_image(path: Path, orientation: int = 6) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    exif = Image.Exif()
    exif[274] = orientation
    Image.new("RGB", (12, 8), "red").save(path, exif=exif)


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


def test_jpeg_display_image_applies_exif_orientation(tmp_path):
    configure_tmp(tmp_path)
    image_path = tmp_path / "portrait.jpg"
    make_oriented_image(image_path, orientation=6)

    display_path = raw_pipeline.ensure_display_image(str(image_path), content_hash="portrait")

    assert display_path != str(image_path)
    assert Path(display_path).name == "portrait-oriented.jpg"
    with Image.open(display_path) as img:
        assert img.size == (8, 12)
        assert 274 not in img.getexif()


def test_jpeg_without_exif_orientation_uses_original_path(tmp_path):
    configure_tmp(tmp_path)
    image_path = tmp_path / "landscape.jpg"
    make_image(image_path)

    assert raw_pipeline.ensure_display_image(str(image_path), content_hash="landscape") == str(image_path)


def test_orientation_override_rotates_raster_without_exif(tmp_path):
    configure_tmp(tmp_path)
    image_path = tmp_path / "landscape.jpg"
    Image.new("RGB", (12, 8), "red").save(image_path)

    display_path = raw_pipeline.ensure_display_image(str(image_path), content_hash="landscape", orientation_override=90)

    assert display_path != str(image_path)
    assert Path(display_path).name == "landscape-override-90.jpg"
    with Image.open(display_path) as img:
        assert img.size == (8, 12)


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
    storage.wait_for_scan(workspace["id"])
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


def test_scan_preserves_score_cache_when_workspace_root_is_unavailable(tmp_path, monkeypatch):
    configure_tmp(tmp_path)
    monkeypatch.setattr("server.scoring.enqueue_scoring", lambda _photo_id, _path: None)
    workspace_root = tmp_path / "source"
    image_path = workspace_root / "photo.jpg"
    make_image(image_path)
    workspace = storage.create_workspace(str(workspace_root))
    storage.wait_for_scan(workspace["id"])
    row = db.list_photos(workspace["id"])[0]
    db.mark_done(row["id"], 92.5, {"reason": "cached"})

    offline_root = tmp_path / "source-offline"
    workspace_root.rename(offline_root)
    storage.scan_workspace(workspace["id"], force_gc=True)

    cached_row = db.fetch_photo(row["id"])
    assert cached_row is not None
    assert cached_row["score"] == 92.5
    assert cached_row["status"] == "done"

    offline_root.rename(workspace_root)
    storage.scan_workspace(workspace["id"], force_gc=True)

    restored_row = db.fetch_photo(row["id"])
    assert restored_row is not None
    assert restored_row["score"] == 92.5
    assert restored_row["status"] == "done"


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
    # Path.home() reads USERPROFILE on Windows and HOME elsewhere, so patch it directly.
    monkeypatch.setattr("server.config.Path.home", lambda: tmp_path)
    monkeypatch.setattr("server.config.platform.system", lambda: "Darwin")

    assert resolve_db_path() == str(tmp_path / "Library" / "Application Support" / "AI Photo Culling" / "ai_culling.db")


def test_default_db_path_uses_appdata_on_windows(monkeypatch, tmp_path):
    monkeypatch.delenv("DB_PATH", raising=False)
    monkeypatch.delenv("AI_CULLING_APP_SUPPORT", raising=False)
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    monkeypatch.setattr("server.config.platform.system", lambda: "Windows")

    assert resolve_db_path() == os.path.join(str(tmp_path / "Roaming"), "AI Photo Culling", "ai_culling.db")


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


def test_init_db_adds_orientation_override_column(tmp_path):
    configure_tmp(tmp_path)

    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(photos)").fetchall()}

    assert "orientation_override" in columns


def test_init_db_adds_similarity_group_cache_table(tmp_path):
    configure_tmp(tmp_path)

    with db.connect() as conn:
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'similarity_group_cache'"
        ).fetchone()

    assert table is not None


def test_reset_interrupted_processing_marks_unscored_rows_pending(tmp_path):
    configure_tmp(tmp_path)
    workspace = db.upsert_workspace("ws1", "Workspace", str(tmp_path))
    db.insert_or_update_photo(
        photo_id="photo-processing",
        workspace_id=workspace["id"],
        name="IMG_9605.dng",
        path=str(tmp_path / "IMG_9605.dng"),
        relative_path="IMG_9605.dng",
        folder="Root",
        folder_path="",
        mtime=1,
        size=100,
        content_hash="hash-processing",
    )
    db.insert_or_update_photo(
        photo_id="photo-done",
        workspace_id=workspace["id"],
        name="IMG_9604.dng",
        path=str(tmp_path / "IMG_9604.dng"),
        relative_path="IMG_9604.dng",
        folder="Root",
        folder_path="",
        mtime=1,
        size=100,
        content_hash="hash-done",
    )
    db.mark_processing("photo-processing")
    db.mark_done("photo-done", 82)
    db.mark_processing("photo-done")

    assert db.reset_interrupted_processing() == 1

    processing = db.fetch_photo("photo-processing")
    done = db.fetch_photo("photo-done")
    assert processing["status"] == "pending"
    assert done["status"] == "processing"
    assert done["score"] == 82


def test_delete_cached_renders_skips_files_in_use(tmp_path, monkeypatch):
    monkeypatch.setattr(raw_pipeline, "_config", SimpleNamespace(render_cache_folder=str(tmp_path)))
    (tmp_path / "abc.jpg").write_bytes(b"x")
    (tmp_path / "abc-oriented.jpg").write_bytes(b"x")
    real_remove = os.remove

    def locked(path):
        if path.endswith("abc-oriented.jpg"):
            raise PermissionError("in use")
        real_remove(path)

    monkeypatch.setattr(raw_pipeline.os, "remove", locked)
    assert raw_pipeline.delete_cached_renders(["abc"]) == 1
    assert not (tmp_path / "abc.jpg").exists()

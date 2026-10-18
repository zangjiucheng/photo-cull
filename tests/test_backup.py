import hashlib
import json
import os
import shutil
import sqlite3
import zipfile
from contextlib import closing
from pathlib import Path

import pytest
from PIL import Image

from server import backup, db, storage
from server.config import AppConfig


@pytest.fixture()
def library(tmp_path):
    config = AppConfig(upload_folder=str(tmp_path / "uploads"), db_path=str(tmp_path / "data" / "lib.db"))
    db.configure(config)
    storage.configure(config)
    db.init_db()
    source = tmp_path / "photos"
    (source / "day1").mkdir(parents=True)
    for name in ("a.jpg", "day1/b.jpg"):
        Image.new("RGB", (16, 16), (200, 100, 50)).save(source / name)
    workspace = storage.create_workspace(str(source))
    storage.wait_for_scan(workspace["id"])
    photos = db.list_photos(workspace["id"])
    db.set_export_enhance_settings(workspace["id"], {
        photos[0]["id"]: {"recipeVersion": 2, "engineVersion": 1, "rawProfileVersion": 1, "exposure": 0.3},
        photos[1]["id"]: {"recipeVersion": 1, "brightness": 1.1},
    })
    db.upsert_preset("p1", "Punchy", {"recipeVersion": 2, "vibrance": 0.3})
    db.insert_snapshot("s1", photos[0]["id"], "First", {"recipeVersion": 2})
    return {"workspace": workspace, "source": source, "tmp": tmp_path, "config": config}


def test_backup_manifest_describes_library(library):
    target = library["tmp"] / "lib.photocull-backup.zip"
    manifest = backup.create_backup(str(target), app_version="9.9.9")
    assert manifest["format"] == "photo-cull-backup" and manifest["appVersion"] == "9.9.9"
    assert manifest["includesOriginals"] is False
    assert manifest["counts"] == {"workspaces": 1, "photos": 2, "recipes": 2, "presets": 1, "snapshots": 1, "exportJobs": 0}
    assert manifest["recipesByEngine"] == {"engine 1 / RAW profile 1": 1, "legacy (v1)": 1}
    assert manifest["presets"] == ["Punchy"]
    with zipfile.ZipFile(target) as archive:
        assert sorted(archive.namelist()) == ["library.db", "manifest.json"]
    inspected = backup.inspect_backup(str(target))
    assert inspected["missingFolders"] == 0 and inspected["workspaces"][0]["folderFound"]
    assert not list(library["tmp"].glob("*.partial"))


def test_tampered_or_foreign_backups_are_rejected(library, tmp_path):
    good = tmp_path / "good.zip"
    backup.create_backup(str(good))
    tampered = tmp_path / "tampered.zip"
    with zipfile.ZipFile(good) as src, zipfile.ZipFile(tampered, "w") as dst:
        dst.writestr("manifest.json", src.read("manifest.json"))
        dst.writestr("library.db", src.read("library.db") + b"junk")
    with pytest.raises(backup.BackupError, match="checksum"):
        backup.inspect_backup(str(tampered))
    newer = tmp_path / "newer.zip"
    with zipfile.ZipFile(good) as src, zipfile.ZipFile(newer, "w") as dst:
        manifest = json.loads(src.read("manifest.json"))
        manifest["formatVersion"] = 99
        dst.writestr("manifest.json", json.dumps(manifest))
        dst.writestr("library.db", src.read("library.db"))
    with pytest.raises(backup.BackupError, match="newer"):
        backup.inspect_backup(str(newer))
    (tmp_path / "plain.zip").write_bytes(b"not a zip")
    with pytest.raises(backup.BackupError, match="damaged"):
        backup.inspect_backup(str(tmp_path / "plain.zip"))


def test_restore_keeps_previous_library_and_upgrades_old_schema(library, tmp_path):
    # Build a backup of an older library that predates presets/snapshots.
    old = tmp_path / "old.db"
    shutil.copyfile(library["config"].db_path, old)
    with closing(sqlite3.connect(old)) as conn, conn:
        conn.execute("DROP TABLE presets")
        conn.execute("DROP TABLE photo_snapshots")
        conn.execute("UPDATE workspaces SET name = 'From backup'")
    archive_path = tmp_path / "old-backup.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("manifest.json", json.dumps({
            "format": "photo-cull-backup", "formatVersion": 1, "workspaces": [],
            "database": {"file": "library.db", "sha256": hashlib.sha256(old.read_bytes()).hexdigest()},
        }))
        archive.write(old, "library.db")

    result = backup.restore_backup(str(archive_path))
    assert result["previousLibrary"] and os.path.exists(result["previousLibrary"])
    assert db.list_workspaces()[0]["name"] == "From backup"
    assert db.list_presets() == []  # table recreated by the migration, data came from the backup
    with closing(sqlite3.connect(result["previousLibrary"])) as conn:
        assert conn.execute("SELECT name FROM presets").fetchone()[0] == "Punchy"


def test_relocate_workspace_after_folder_moves(library, tmp_path):
    moved = tmp_path / "moved-photos"
    shutil.move(str(library["source"]), moved)
    workspace_id = library["workspace"]["id"]
    assert db.row_to_workspace(db.fetch_workspace(workspace_id))["folderFound"] is False

    unrelated = tmp_path / "other"
    unrelated.mkdir()
    with pytest.raises(backup.BackupError, match="sampled photos"):
        backup.relocate_workspace(workspace_id, str(unrelated))

    result = backup.relocate_workspace(workspace_id, str(moved))
    assert result["found"] == result["checked"] == 2
    assert result["workspace"]["folderFound"] and result["workspace"]["rootPath"] == os.path.realpath(moved)

    # Opening the old path again later must not collide with the relocated workspace's id.
    library["source"].mkdir()
    again = storage.create_workspace(str(library["source"]))
    assert again["id"] != workspace_id
    with pytest.raises(backup.BackupError, match="already uses"):
        backup.relocate_workspace(workspace_id, str(library["source"]))

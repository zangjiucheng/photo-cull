import time
from pathlib import Path

import pytest
from PIL import Image

from server import db, export_enhance, storage
from server.app import create_app
from server.config import AppConfig


def configure_tmp(tmp_path: Path) -> AppConfig:
    config = AppConfig(upload_folder=str(tmp_path / "uploads"), db_path=str(tmp_path / "data" / "test.db"))
    db.configure(config)
    storage.configure(config)
    db.init_db()
    return config


def library(tmp_path: Path, names=("a.jpg", "b.jpg", "c.jpg")):
    source = tmp_path / "source"
    source.mkdir()
    for index, name in enumerate(names):
        Image.new("RGB", (32, 24), (40 * index, 90, 160)).save(source / name, quality=90)
    workspace = storage.create_workspace(str(source))
    storage.wait_for_scan(workspace["id"])
    return workspace, sorted(db.list_photos(workspace["id"]), key=lambda row: row["name"])


def wait(queue, job_id):
    deadline = time.time() + 30
    while queue.get(job_id).status in {"queued", "running"}:
        assert time.time() < deadline
        time.sleep(0.02)
    return queue.get(job_id)


def test_interrupted_export_resumes_without_rewriting_finished_photos(tmp_path, monkeypatch):
    configure_tmp(tmp_path)
    workspace, rows = library(tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    first = export_enhance.JobQueue()
    original_write = first._writer.write
    written = []

    def write_until_crash(image, row, *args):
        if row["name"] == "b.jpg":
            raise KeyboardInterrupt  # stands in for the process dying mid-export
        written.append(row["name"])
        return original_write(image, row, *args)

    monkeypatch.setattr(first._writer, "write", write_until_crash)
    job = first.create([row["id"] for row in rows], str(out), export_enhance.EnhanceSettings(recipe_version=2))
    # Wait for a.jpg to be recorded as done, not just handed to the writer: on a slow runner the
    # file write and database update can take longer than any fixed sleep.
    deadline = time.time() + 30
    while not any(item["name"] == "a.jpg" and item["status"] == "done" for item in db.fetch_export_job(job.id)[1]):
        assert time.time() < deadline
        time.sleep(0.02)
    time.sleep(0.2)
    assert written == ["a.jpg"]

    # A new process: running jobs become interrupted, the finished file is kept.
    assert db.mark_interrupted_export_jobs() == 1
    second = export_enhance.JobQueue()
    restored = second.get(job.id)
    assert restored.status == "interrupted" and restored.completed == 1
    payload = export_enhance.serialize_job(restored)
    assert payload["resumable"] and payload["pending"] == 2
    before = (out / "a_enhanced.jpg").stat().st_mtime_ns

    done = wait(second, second.resume(job.id).id)
    assert done.status == "done" and done.completed == 3 and done.failed == 0
    assert sorted(p.name for p in out.iterdir()) == ["a_enhanced.jpg", "b_enhanced.jpg", "c_enhanced.jpg"]
    assert (out / "a_enhanced.jpg").stat().st_mtime_ns == before


def test_retry_failed_only_reprocesses_failures(tmp_path, monkeypatch):
    configure_tmp(tmp_path)
    _workspace, rows = library(tmp_path, ("a.jpg", "b.jpg"))
    out = tmp_path / "out"
    out.mkdir()
    queue = export_enhance.JobQueue()
    original_write = queue._writer.write
    calls = []

    # Fail in the writer: loads also run ahead on the prefetch thread, which would hide a load failure.
    def flaky(image, row, *args):
        calls.append(row["name"])
        if row["name"] == "b.jpg" and calls.count("b.jpg") == 1:
            raise RuntimeError("disk hiccup")
        return original_write(image, row, *args)

    monkeypatch.setattr(queue._writer, "write", flaky)
    job = wait(queue, queue.create([row["id"] for row in rows], str(out), export_enhance.EnhanceSettings(recipe_version=2)).id)
    assert job.completed == 1 and job.failed == 1 and job.failures[0].error == "disk hiccup"

    retried = wait(queue, queue.resume(job.id, retry_failed=True).id)
    assert retried.completed == 2 and retried.failed == 0
    assert calls.count("a.jpg") == 1  # the finished photo was not processed again
    assert sorted(p.name for p in out.iterdir()) == ["a_enhanced.jpg", "b_enhanced.jpg"]


def test_writer_leaves_no_partial_file_on_failure(tmp_path, monkeypatch):
    out = tmp_path / "out"
    out.mkdir()
    row = {"name": "x.dng", "id": "x"}
    image = __import__("numpy").full((8, 8, 3), 0.5, "float32")

    def broken_save(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(Image.Image, "save", broken_save)
    with pytest.raises(OSError):
        export_enhance.ExportWriter().write(image, row, str(out), export_enhance.EnhanceSettings(), None)
    assert list(out.iterdir()) == []


@pytest.fixture()
def client(tmp_path, monkeypatch):
    app = create_app(AppConfig(upload_folder=str(tmp_path / "uploads"), db_path=str(tmp_path / "data" / "test.db")))
    app.config.update(TESTING=True)
    monkeypatch.setattr("server.scoring.enqueue_scoring", lambda _photo_id, _path: None)
    return app.test_client()


def test_snapshots_store_named_recipes(client, tmp_path):
    _workspace, rows = library(tmp_path, ("a.jpg",))
    photo_id = rows[0]["id"]
    created = client.post(f"/api/photos/{photo_id}/snapshots", json={"name": "Warm", "settings": {"recipeVersion": 2, "exposure": 0.4}})
    assert created.status_code == 201 and created.get_json()["settings"]["exposure"] == 0.4
    snap = created.get_json()["id"]
    assert client.patch(f"/api/snapshots/{snap}", json={"name": "Warm v2"}).get_json()["name"] == "Warm v2"
    assert [s["name"] for s in client.get(f"/api/photos/{photo_id}/snapshots").get_json()["snapshots"]] == ["Warm v2"]
    assert client.post(f"/api/photos/{photo_id}/snapshots", json={"name": "", "settings": {}}).status_code == 400
    assert client.delete(f"/api/snapshots/{snap}").get_json()["deleted"] is True
    assert client.get(f"/api/photos/{photo_id}/snapshots").get_json()["snapshots"] == []


def test_presets_import_rename_delete(client):
    look = {"recipeVersion": 2, "vibrance": 0.3}
    imported = client.post("/api/presets", json={"presets": [{"name": "Punchy", "settings": look}, {"name": "Soft", "settings": look}]})
    assert [p["name"] for p in imported.get_json()["presets"]] == ["Punchy", "Soft"]
    # Saving under an existing name updates it instead of duplicating.
    client.post("/api/presets", json={"name": "Soft", "settings": {"recipeVersion": 2, "vibrance": -0.2}})
    presets = client.get("/api/presets").get_json()["presets"]
    assert len(presets) == 2 and presets[1]["settings"]["vibrance"] == -0.2
    punchy = presets[0]["id"]
    assert client.patch(f"/api/presets/{punchy}", json={"name": "Soft"}).status_code == 409
    assert client.patch(f"/api/presets/{punchy}", json={"name": "Vivid"}).get_json()["preset"]["name"] == "Vivid"
    assert client.post("/api/presets", json={"presets": [{"name": "Bad", "settings": {"recipeVersion": 99}}]}).status_code == 400
    assert [p["name"] for p in client.delete(f"/api/presets/{punchy}").get_json()["presets"]] == ["Soft"]


def test_jobs_listing_and_resume_endpoints(client, tmp_path):
    workspace, rows = library(tmp_path, ("a.jpg",))
    out = tmp_path / "out"
    out.mkdir()
    created = client.post("/api/export-enhance/jobs", json={"selected_ids": [rows[0]["id"]], "output_folder": str(out), "settings": {"recipeVersion": 2}})
    job_id = created.get_json()["id"]
    wait(export_enhance.queue, job_id)
    listed = client.get(f"/api/export-enhance/jobs?workspace_id={workspace['id']}").get_json()["jobs"]
    assert [job["id"] for job in listed] == [job_id] and listed[0]["status"] == "done"
    resumed = client.post(f"/api/export-enhance/jobs/{job_id}/resume", json={})
    assert resumed.status_code == 200 and resumed.get_json()["status"] == "done"
    assert client.post("/api/export-enhance/jobs/missing/resume", json={}).status_code == 404


def test_finished_jobs_leave_the_memory_cache(tmp_path):
    configure_tmp(tmp_path)
    _workspace, rows = library(tmp_path, ("a.jpg",))
    out = tmp_path / "out"
    out.mkdir()
    queue = export_enhance.JobQueue()
    job = wait(queue, queue.create([rows[0]["id"]], str(out), export_enhance.EnhanceSettings(recipe_version=2)).id)
    deadline = time.time() + 5
    while job.id in queue._jobs and time.time() < deadline:
        time.sleep(0.02)
    assert job.id not in queue._jobs
    assert queue.get(job.id).status == "done" and queue.get(job.id).completed == 1

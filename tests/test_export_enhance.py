from pathlib import Path

import numpy as np
from PIL import Image

from server import db, export_enhance, storage
from server import raw_pipeline
from server.config import AppConfig


def configure_tmp(tmp_path: Path) -> AppConfig:
    config = AppConfig(upload_folder=str(tmp_path / "uploads"), db_path=str(tmp_path / "data" / "test.db"))
    db.configure(config)
    storage.configure(config)
    db.init_db()
    return config


def make_image(path: Path, color: str = "blue") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color).save(path)


def fake_rawpy_for_export(monkeypatch):
    from io import BytesIO
    from types import SimpleNamespace

    thumb_buffer = BytesIO()
    Image.new("RGB", (4, 3), "green").save(thumb_buffer, format="JPEG")

    class FakeRaw:
        def __enter__(self):
            return self

        def __exit__(self, _exc_type, _exc, _traceback):
            return False

        def extract_thumb(self):
            return SimpleNamespace(format="jpeg", data=thumb_buffer.getvalue())

        def postprocess(self, **kwargs):
            return np.full((10, 20, 3), 32768 if kwargs.get("output_bps") == 16 else 128,
                           dtype=np.uint16 if kwargs.get("output_bps") == 16 else np.uint8)

    module = SimpleNamespace(
        ThumbFormat=SimpleNamespace(JPEG="jpeg", BITMAP="bitmap"),
        ColorSpace=SimpleNamespace(sRGB="sRGB"),
        imread=lambda _path: FakeRaw(),
    )
    monkeypatch.setattr(raw_pipeline.importlib.util, "find_spec", lambda name: object() if name == "rawpy" else None)
    monkeypatch.setattr(raw_pipeline.importlib, "import_module", lambda name: module if name == "rawpy" else __import__(name))


def test_color_processor_clamps_and_changes_pixels():
    image = np.full((4, 4, 3), 0.5, dtype=np.float32)
    settings = export_enhance.EnhanceSettings(exposure=1.0, contrast=0.5, saturation=0.5, temperature=0.5)

    out = export_enhance.ColorProcessor().apply(image, settings)

    assert out.dtype == np.float32
    assert out.min() >= 0
    assert out.max() <= 1
    assert not np.allclose(out, image)


def test_photo_style_palette_zero_preserves_original():
    image = np.random.default_rng(2).random((12, 10, 3), dtype=np.float32)
    settings = export_enhance.EnhanceSettings(
        photo_style=export_enhance.PhotoStyle(preset="dramatic", tone=80, colour=60, palette=0)
    )

    out = export_enhance.PhotographicStyleProcessor().apply(image, settings)

    assert np.allclose(out, image)


def test_photo_style_parse_fallback_and_clamp():
    settings = export_enhance.parse_settings({
        "photoStyle": {"preset": "unknown", "tone": 500, "colour": -500, "palette": 150}
    })

    assert settings.photo_style.preset == "standard"
    assert settings.photo_style.tone == 100
    assert settings.photo_style.colour == -100
    assert settings.photo_style.palette == 100


def test_upscale_settings_parse_and_validate():
    settings = export_enhance.parse_settings({"upscale": True, "upscaleScale": 4})

    assert settings.upscale is True
    assert settings.upscale_scale == 4

    try:
        export_enhance.parse_settings({"upscale": True, "upscaleScale": 3})
    except export_enhance.ExportEnhanceError as exc:
        assert "upscaleScale" in str(exc)
    else:
        raise AssertionError("Expected invalid upscale scale to fail")


def test_ai_denoise_settings_parse_and_validate():
    settings = export_enhance.parse_settings({"aiDenoise": True, "aiDenoiseStrength": "high"})

    assert settings.ai_denoise is True
    assert settings.ai_denoise_strength == "high"

    try:
        export_enhance.parse_settings({"aiDenoise": True, "aiDenoiseStrength": "extreme"})
    except export_enhance.ExportEnhanceError as exc:
        assert "aiDenoiseStrength" in str(exc)
    else:
        raise AssertionError("Expected invalid denoise strength to fail")


def test_ai_denoise_engine_preserves_shape_and_range():
    image = np.random.default_rng(6).random((10, 12, 3), dtype=np.float32)

    out = export_enhance.AIDenoiseEngine().apply(image, "medium")

    assert out.shape == image.shape
    assert out.dtype == np.float32
    assert out.min() >= 0
    assert out.max() <= 1


def test_realesrgan_source_root_is_importable(tmp_path):
    engine = export_enhance.RealESRGANEngine(model_dir=str(tmp_path / "models"))
    package_dir = engine.source_dir / "RealESRGAN"
    package_dir.mkdir(parents=True)
    (package_dir / "__init__.py").write_text("class RealESRGAN: pass\n", encoding="utf-8")

    source_root = str(engine.source_dir)

    assert source_root.endswith("source")


def test_photo_style_processor_skin_protection_reduces_shift():
    image = np.zeros((8, 8, 3), dtype=np.float32)
    image[:, :4] = np.array([0.74, 0.48, 0.36], dtype=np.float32)
    image[:, 4:] = np.array([0.22, 0.44, 0.82], dtype=np.float32)
    settings = export_enhance.EnhanceSettings(
        recipe_version=1,
        photo_style=export_enhance.PhotoStyle(preset="dramatic", tone=100, colour=100, palette=100)
    )

    out = export_enhance.PhotographicStyleProcessor().apply(image, settings)
    skin_shift = np.abs(out[:, :4] - image[:, :4]).mean()
    background_shift = np.abs(out[:, 4:] - image[:, 4:]).mean()

    assert skin_shift < background_shift


def test_semantic_masks_are_rgba_and_clamped():
    image = np.zeros((6, 7, 3), dtype=np.float32)
    image[..., 2] = 0.9

    masks = export_enhance.SemanticMaskProvider()._build_masks(image)

    assert masks.shape == (6, 7, 4)
    assert masks.min() >= 0
    assert masks.max() <= 1


def test_semantic_mask_cache_keeps_preview_and_full_size_separate():
    provider = export_enhance.SemanticMaskProvider()
    row = {"path": "DJI_0352.DNG"}
    preview = np.zeros((720, 960, 3), dtype=np.float32)
    full = np.zeros((3000, 4000, 3), dtype=np.float32)

    preview_masks = provider.masks_for_row(row, preview)
    full_masks = provider.masks_for_row(row, full)

    assert preview_masks.shape == (720, 960, 4)
    assert full_masks.shape == (3000, 4000, 4)


def test_heif_extensions_are_allowed():
    assert storage.allowed_image("photo.heic")
    assert storage.allowed_image("photo.heif")


def test_export_enhance_color_only_job_writes_files(tmp_path):
    configure_tmp(tmp_path)
    source = tmp_path / "source"
    make_image(source / "a.jpg")
    workspace = storage.create_workspace(str(source))
    storage.wait_for_scan(workspace["id"])
    row = db.list_photos(workspace["id"])[0]
    output = tmp_path / "out"
    output.mkdir()

    job = export_enhance.queue.create(
        selected_ids=[row["id"]],
        output_folder=str(output),
        settings=export_enhance.EnhanceSettings(exposure=0.2, sharpen=0.1),
    )
    while export_enhance.queue.get(job.id).status in {"queued", "running"}:
        pass
    finished = export_enhance.queue.get(job.id)

    assert finished.status == "done"
    assert finished.completed == 1
    assert Path(finished.outputs[0]).name == "a_enhanced.jpg"
    assert Path(finished.outputs[0]).exists()


def test_export_enhance_dng_uses_full_raw_render_not_embedded_thumbnail(tmp_path, monkeypatch):
    configure_tmp(tmp_path)
    fake_rawpy_for_export(monkeypatch)
    source = tmp_path / "source"
    dng_path = source / "a.dng"
    dng_path.parent.mkdir(parents=True)
    dng_path.write_bytes(b"fake-dng")
    workspace = storage.create_workspace(str(source))
    storage.wait_for_scan(workspace["id"])
    row = db.list_photos(workspace["id"])[0]
    output = tmp_path / "out"
    output.mkdir()

    job = export_enhance.queue.create(
        selected_ids=[row["id"]],
        output_folder=str(output),
        settings=export_enhance.EnhanceSettings(),
    )
    while export_enhance.queue.get(job.id).status in {"queued", "running"}:
        pass
    finished = export_enhance.queue.get(job.id)

    assert finished.status == "done"
    with Image.open(finished.outputs[0]) as img:
        assert img.size == (20, 10)


def test_export_writer_saves_tiff_16_bit(tmp_path):
    configure_tmp(tmp_path)
    source = tmp_path / "source"
    make_image(source / "a.jpg")
    workspace = storage.create_workspace(str(source))
    storage.wait_for_scan(workspace["id"])
    row = db.list_photos(workspace["id"])[0]
    image = np.full((4, 4, 3), 0.5, dtype=np.float32)

    output = export_enhance.ExportWriter().write(
        image,
        row,
        str(tmp_path / "out"),
        export_enhance.EnhanceSettings(output_format="tiff"),
        None,
    )

    import tifffile

    arr = tifffile.imread(output)
    assert arr.dtype == np.uint16
    assert arr.shape == (4, 4, 3)


def test_export_enhance_job_uses_per_photo_settings(tmp_path):
    configure_tmp(tmp_path)
    source = tmp_path / "source"
    make_image(source / "a.jpg", "red")
    make_image(source / "b.jpg", "green")
    workspace = storage.create_workspace(str(source))
    storage.wait_for_scan(workspace["id"])
    rows = db.list_photos(workspace["id"])
    output = tmp_path / "out"
    output.mkdir()

    settings_by_photo = {
        row["id"]: export_enhance.EnhanceSettings(output_format="tiff" if row["name"] == "b.jpg" else "jpeg")
        for row in rows
    }
    job = export_enhance.queue.create(
        selected_ids=[row["id"] for row in rows],
        output_folder=str(output),
        settings=export_enhance.EnhanceSettings(output_format="jpeg"),
        settings_by_photo=settings_by_photo,
    )
    while export_enhance.queue.get(job.id).status in {"queued", "running"}:
        pass
    finished = export_enhance.queue.get(job.id)

    names = {Path(path).name for path in finished.outputs}
    assert "a_enhanced.jpg" in names
    assert "b_enhanced.tif" in names


def test_export_enhance_job_continues_after_failure(tmp_path, monkeypatch):
    configure_tmp(tmp_path)
    source = tmp_path / "source"
    make_image(source / "a.jpg", "red")
    make_image(source / "b.jpg", "green")
    workspace = storage.create_workspace(str(source))
    storage.wait_for_scan(workspace["id"])
    rows = db.list_photos(workspace["id"])
    output = tmp_path / "out"
    output.mkdir()

    original_load = export_enhance.queue._export_loader.load

    def flaky_load(row):
        if row["name"] == "a.jpg":
            raise RuntimeError("broken")
        return original_load(row)

    monkeypatch.setattr(export_enhance.queue._export_loader, "load", flaky_load)
    job = export_enhance.queue.create(
        selected_ids=[row["id"] for row in rows],
        output_folder=str(output),
        settings=export_enhance.EnhanceSettings(),
    )
    while export_enhance.queue.get(job.id).status in {"queued", "running"}:
        pass
    finished = export_enhance.queue.get(job.id)

    assert finished.status == "done"
    assert finished.completed == 1
    assert finished.failed == 1
    assert finished.failures[0].error == "broken"


def test_image_loader_shares_inflight_decode_and_caches_scaled(tmp_path, monkeypatch):
    import threading
    path = tmp_path / "a.jpg"
    path.write_bytes(b"x")
    row = {"path": str(path), "orientation_override": 0}
    loader = export_enhance.ImageLoader()
    calls, release = [], threading.Event()

    def slow_decode(_row):
        calls.append(1)
        release.wait(2)
        return np.full((40, 60, 3), .5, np.float32), None, str(path)

    monkeypatch.setattr(loader, "_decode", slow_decode)
    results = []
    threads = [threading.Thread(target=lambda: results.append(loader.load(row))) for _ in range(3)]
    for thread in threads:
        thread.start()
    release.set()
    for thread in threads:
        thread.join()
    assert len(calls) == 1 and len(results) == 3 and all(r is results[0] for r in results)
    scaled = loader.load_scaled(row, 30)
    assert scaled.shape == (20, 30, 3) and loader.load_scaled(row, 30) is scaled
    loader._cache.clear()  # Cached editor bases must not force another RAW decode for metadata.
    assert loader.source_size(row) == (60, 40)
    assert loader.load_scaled(row, 30) is scaled and len(calls) == 1


def test_export_uses_its_own_loader_cache():
    assert export_enhance.queue._export_loader is not export_enhance.queue._loader
    assert export_enhance.queue._export_loader._budget is export_enhance.queue._loader._budget
    assert export_enhance.queue._masks._loader is export_enhance.queue._loader


def test_prefetch_warms_editor_caches(monkeypatch):
    calls = []
    monkeypatch.setattr(export_enhance.queue._loader, "load_scaled", lambda row, edge: calls.append(edge))
    export_enhance.queue.prefetch({"id": "x", "path": "x"})
    export_enhance.queue._prefetcher.submit(lambda: None).result(timeout=5)
    assert calls == [1600, 512]


def test_editor_and_export_share_resident_budget_with_one_oversized_exception(tmp_path, monkeypatch):
    monkeypatch.setattr(export_enhance.time, "monotonic_ns", lambda: 0)
    budget = export_enhance.CacheBudget(max_bytes=2400)
    editor, batch = export_enhance.ImageLoader(budget=budget), export_enhance.ImageLoader(budget=budget)
    rows = []
    for name in ("a", "b", "c", "large"):
        path = tmp_path / name
        path.write_bytes(b"x")
        rows.append({"path": str(path), "orientation_override": None})
    def decode(row):
        edge = 30 if row["path"].endswith("large") else 10
        return np.zeros((edge, edge, 3), np.float32), None, row["path"]
    for loader in (editor, batch):
        monkeypatch.setattr(loader, "_decode", decode)
    editor.load(rows[0]); batch.load(rows[1]); editor.load(rows[0]); batch.load(rows[2])
    assert len(editor._cache) == len(batch._cache) == 1
    assert next(iter(batch._cache))[0].endswith("c")  # Globally least-recently-used b was evicted.
    large = batch.load(rows[3])[0]
    assert large.nbytes > budget.max_bytes
    assert len(editor._cache) == 0 and len(batch._cache) == 1
    small = batch.load_scaled(rows[3], 5)
    assert small.shape == (5, 5, 3) and not batch._scaled
    assert batch.load(rows[3])[0] is large
    editor.load(rows[0])
    assert not batch._cache  # A newly used small photo can replace an old oversized one.
    assert len(editor._cache) == 1


def test_prefetch_queue_cancels_obsolete_work():
    import threading
    jobs = export_enhance.JobQueue()
    started, release = threading.Event(), threading.Event()
    executed = []
    def blocking():
        started.set()
        release.wait(5)
    try:
        jobs._submit_prefetch(("test", 0), blocking)
        assert started.wait(2)
        for i in range(1, 31):
            jobs._submit_prefetch(("test", i), lambda i=i: executed.append(i))
        assert len(jobs._prefetch_tasks) <= 3
        release.set()
        jobs._prefetcher.submit(lambda: None).result(timeout=5)
        assert executed == [29, 30]
    finally:
        release.set()
        jobs._prefetcher.shutdown(wait=True)
        jobs._executor.shutdown(wait=True)

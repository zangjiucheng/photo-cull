from pathlib import Path

import numpy as np
from PIL import Image

from server import db, export_enhance, storage
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


def test_photo_style_processor_skin_protection_reduces_shift():
    image = np.zeros((8, 8, 3), dtype=np.float32)
    image[:, :4] = np.array([0.74, 0.48, 0.36], dtype=np.float32)
    image[:, 4:] = np.array([0.22, 0.44, 0.82], dtype=np.float32)
    settings = export_enhance.EnhanceSettings(
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


def test_heif_extensions_are_allowed():
    assert storage.allowed_image("photo.heic")
    assert storage.allowed_image("photo.heif")


def test_tile_inference_identity_preserves_shape_and_values():
    image = np.random.default_rng(1).random((23, 31, 3), dtype=np.float32)
    engine = export_enhance.TileInferenceEngine(tile_size=12, overlap=4)

    out = engine.run(image, lambda patch: patch)

    assert out.shape == image.shape
    assert np.allclose(out, image, atol=1e-5)


def test_restormer_corrupt_weight_is_removed(tmp_path):
    engine = export_enhance.RestormerEngine(model_dir=str(tmp_path / "models"))
    target = engine.model_dir / "denoise.pth"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"not-a-checkpoint")

    assert engine._looks_like_checkpoint(target) is False


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

    original_load = export_enhance.queue._loader.load

    def flaky_load(row):
        if row["name"] == "a.jpg":
            raise RuntimeError("broken")
        return original_load(row)

    monkeypatch.setattr(export_enhance.queue._loader, "load", flaky_load)
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

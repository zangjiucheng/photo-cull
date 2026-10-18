from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from server import editing, export_enhance, raw_pipeline


def test_raw_decode_keeps_sub_8bit_steps_and_explicit_development(tmp_path, monkeypatch):
    path = tmp_path / "DJI.DNG"
    path.write_bytes(b"fixture")
    calls = []
    class Raw:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def postprocess(self, **kwargs):
            calls.append(kwargs)
            return np.repeat(np.arange(1024, dtype=np.uint16)[None, :, None], 3, axis=2)
    monkeypatch.setattr(raw_pipeline, "_load_rawpy", lambda: SimpleNamespace(imread=lambda _: Raw(), ColorSpace=SimpleNamespace(sRGB="srgb")))
    decoded = raw_pipeline.load_full_raw_array(str(path), 90)
    assert decoded.shape == (1024, 1, 3)
    assert np.unique(decoded[..., 0]).size == 1024
    assert calls == [dict(output_bps=16, gamma=(1, 1), use_camera_wb=True, no_auto_bright=True, output_color="srgb")]


def test_neutral_is_identity_including_sky_and_foliage():
    image = np.random.default_rng(2).random((40, 80, 3), dtype=np.float32)
    settings = export_enhance.EnhanceSettings()
    out = export_enhance.ColorProcessor().apply(image, settings)
    out = export_enhance.PhotographicStyleProcessor().apply(out, settings)
    np.testing.assert_allclose(out, image, atol=2e-7)


def test_exposure_operates_in_linear_light_and_roundtrips():
    source = np.full((4, 5, 3), .1, np.float32)
    out = editing.apply_color(source, SimpleNamespace(exposure=1))
    np.testing.assert_allclose(editing.decode_srgb(out), editing.decode_srgb(source) * 2, atol=1e-7)
    np.testing.assert_allclose(editing.encode_srgb(editing.decode_srgb(source)), source, atol=1e-7)


def test_resize_sharpen_and_tiff_keep_more_than_256_levels(tmp_path):
    import tifffile
    ramp = np.repeat(np.linspace(.1, .9, 2048, dtype=np.float32)[None, :, None], 3, axis=2)
    ramp = np.repeat(ramp, 4, axis=0)
    settings = export_enhance.EnhanceSettings(output_format="tiff", resize_max_edge=1024, sharpen=.4)
    path = export_enhance.ExportWriter().write(ramp, {"name": "ramp.dng", "id": "r"}, str(tmp_path), settings, None)
    with tifffile.TiffFile(path) as tif:
        data = tif.asarray()
        assert data.dtype == np.uint16
        assert len(np.unique(data[0, :, 0])) > 1000
        assert tif.pages[0].tags[34675].value == editing.SRGB_ICC
        assert tif.pages[0].tags[274].value == 1
        assert tif.pages[0].tags[34665].value["PixelXDimension"] == 1024
    loaded, _, _ = export_enhance.ImageLoader().load({"path": path, "orientation_override": None})
    assert len(np.unique(loaded[0, :, 0])) > 1000


def test_export_embeds_srgb_and_rewrites_orientation_dimensions(tmp_path):
    exif = Image.Exif()
    exif[274] = 6
    exif[271] = "DJI"
    exif[34665] = {36867: "2025:01:02 03:04:05", 40962: 999, 40963: 888}
    image = np.full((10, 20, 3), .5, np.float32)
    writer = export_enhance.ExportWriter()
    path = writer.write(image, {"id": "r", "name": "DJI.DNG"}, str(tmp_path), export_enhance.EnhanceSettings(), exif.tobytes())
    other = writer.write(image, {"id": "r", "name": "DJI.DNG"}, str(tmp_path), export_enhance.EnhanceSettings(), None)
    assert path != other
    with Image.open(path) as exported:
        assert exported.info["icc_profile"] == editing.SRGB_ICC
        saved = exported.getexif()
        assert saved[274] == 1 and saved[256] == 20 and saved[257] == 10
        assert saved[271] == "DJI"
        assert saved.get_ifd(34665)[40962] == 20
        assert saved.get_ifd(34665)[36867] == "2025:01:02 03:04:05"


def test_recipe_legacy_and_new_fields_roundtrip_and_reject_nonfinite():
    assert export_enhance.parse_settings({}).recipe_version == 1
    settings = export_enhance.parse_settings({"recipeVersion": 2, "brilliance": .4, "blackPoint": .2,
        "crop": {"x": .9, "width": .5, "angle": 8}})
    assert settings.crop["x"] == .5
    assert export_enhance.parse_settings(export_enhance.serialize_settings(settings)) == settings
    with pytest.raises(export_enhance.ExportEnhanceError):
        export_enhance.parse_settings({"exposure": float("nan")})
    for value in ({"quality": []}, {"resizeMaxEdge": {}}, {"recipeVersion": 99}, {"quality": float("inf")}):
        with pytest.raises(export_enhance.ExportEnhanceError):
            export_enhance.parse_settings(value)


def test_tiff_retains_capture_exif(tmp_path):
    import tifffile
    exif = Image.Exif()
    exif[271] = "DJI"
    exif[34665] = {33434: .01, 33437: 2.8, 34855: 100, 36867: "2026:10:18 00:00:00"}
    path = export_enhance.ExportWriter().write(np.ones((5, 8, 3), np.float32) * .5,
        {"id": "t", "name": "DJI.DNG"}, str(tmp_path), export_enhance.EnhanceSettings(output_format="tiff"), exif.tobytes())
    with tifffile.TiffFile(path) as tif:
        assert tif.pages[0].tags[271].value == "DJI"
        assert tif.pages[0].tags[305].value == "Photo Cull"
        capture = tif.pages[0].tags[34665].value
        assert capture["ExposureTime"] == (1, 100)
        assert capture["FNumber"] == (14, 5)
        assert capture["DateTimeOriginal"] == "2026:10:18 00:00:00"


def test_noise_reduction_reports_real_fallback(monkeypatch):
    engine = export_enhance.AIDenoiseEngine()
    monkeypatch.setattr(engine, "_opencv_denoise", lambda *_: None)
    image, name = engine.apply_with_info(np.ones((8, 8, 3), np.float32) * .4, "low")
    assert "Pillow" in name and "OpenCV unavailable" in name
    assert image.shape == (8, 8, 3)


def test_straighten_keeps_edges_inside_source_and_ratio():
    image = np.ones((240, 320, 3), np.float32)
    crop = {"x": 0, "y": 0, "width": 1, "height": 1, "angle": 12}
    out = editing.apply_geometry(image, crop)
    assert out.min() > .99
    assert abs(out.shape[1] / out.shape[0] - 4 / 3) < .01
    assert out.shape[0] < image.shape[0]


def test_profile_tone_curve_adds_contrast_and_preserves_hue():
    curve = np.array([[0, 0], [.1, .05], [.18, .26], [.5, .67], [1, 1]], np.float32)
    linear = np.array([[[.02, .02, .02], [.18, .18, .18], [.6, .6, .6], [.4, .2, .1]]], np.float32)
    out = editing.apply_profile_tone(linear, curve)
    assert out[0, 0, 0] < .02 and out[0, 1, 0] > .18 and out[0, 2, 0] > .6
    assert np.allclose(out[0, :3, 0], out[0, :3, 1]) and np.allclose(out[0, :3, 1], out[0, :3, 2])
    # The middle channel keeps its relative position, so the hue does not drift.
    r, g, b = out[0, 3]
    assert np.isclose((g - b) / (r - b), (.2 - .1) / (.4 - .1), atol=1e-5)


def test_profile_tone_curve_reads_dng_tag_and_rejects_invalid(tmp_path):
    import tifffile
    good, bad, missing = tmp_path / "good.dng", tmp_path / "bad.dng", tmp_path / "none.dng"
    pairs = [0, 0, .5, .7, 1, 1]
    tifffile.imwrite(good, np.zeros((2, 2), np.uint8), extratags=[(50940, "f", len(pairs), pairs, False)])
    tifffile.imwrite(bad, np.zeros((2, 2), np.uint8), extratags=[(50940, "f", 4, [0, 0, 0, 1], False)])
    tifffile.imwrite(missing, np.zeros((2, 2), np.uint8))
    assert np.allclose(raw_pipeline.profile_tone_curve(str(good)), [[0, 0], [.5, .7], [1, 1]])
    assert raw_pipeline.profile_tone_curve(str(bad)) is None
    assert raw_pipeline.profile_tone_curve(str(missing)) is None


def test_auto_does_not_flatten_a_normal_daylight_scene():
    gradient = np.repeat(np.linspace(.08, .8, 64, dtype=np.float32)[:, None, None], 3, axis=2)
    auto = editing.auto_adjustments(np.repeat(gradient, 8, axis=1))
    assert auto["shadows"] == 0 and auto["highlights"] == 0 and auto["vibrance"] > 0


def test_auto_preserves_dark_scene_and_never_rebalances_sunset():
    night = editing.auto_adjustments(np.full((32, 32, 3), .04, np.float32))
    sunset = editing.auto_adjustments(np.full((32, 32, 3), [.8, .35, .1], np.float32))
    assert night["exposure"] == 0 and night["shadows"] <= .05
    assert sunset["temperature"] == 0


def test_style_pad_vectors_adapt_to_the_photo():
    rng = np.random.default_rng(7)
    flat = (rng.random((32, 32, 3), dtype=np.float32) * .3 + .35)
    crushed = flat.copy(); crushed[:12] = 0.0
    bright = flat.copy(); bright[:8] = 1.0
    open_shadows = editing.style_pad_vectors(flat)["tone"]["up"]
    assert open_shadows["contrast"] > 0 and open_shadows["shadows"] < 0
    assert editing.style_pad_vectors(crushed)["tone"]["up"]["shadows"] == 0
    assert editing.style_pad_vectors(bright)["tone"]["up"]["highlights"] < 0
    skin = np.zeros((32, 32, 4), np.float32); skin[..., 0] = 1
    vivid = editing.style_pad_vectors(flat)["colour"]["up"]
    assert editing.style_pad_vectors(flat, skin)["colour"]["up"]["saturation"] < vivid["saturation"]
    for side in ("up", "down"):
        assert set(editing.style_pad_vectors(flat)["tone"][side]) <= set(editing.PAD_KEYS)


def test_pad_state_roundtrips_and_clamps():
    vectors = editing.style_pad_vectors(np.full((8, 8, 3), .5, np.float32))
    raw = {"recipeVersion": 2, "contrast": .2,
           "pad": {"tone": 3, "colour": -.4, "base": {"contrast": 0}, "vectors": vectors}}
    parsed = export_enhance.parse_settings(raw)
    assert parsed.pad["tone"] == 1 and parsed.pad["colour"] == -.4
    assert parsed.pad["base"]["saturation"] == 0
    again = export_enhance.parse_settings(export_enhance.serialize_settings(parsed))
    assert again.pad == parsed.pad
    with pytest.raises(export_enhance.ExportEnhanceError):
        export_enhance.parse_settings({"recipeVersion": 2, "pad": {"tone": 0}})


def test_style_presets_are_complete_and_render():
    keys = {"exposure", "brilliance", "highlights", "shadows", "contrast", "blackPoint",
            "vibrance", "saturation", "temperature", "tint"}
    image = np.random.default_rng(9).random((16, 16, 3), dtype=np.float32)
    assert len(editing.PRESETS) >= 15
    for preset_id, preset in editing.PRESETS.items():
        assert keys <= set(preset) and preset["label"] and preset["group"], preset_id
        out = editing.apply_style(image, export_enhance.PhotoStyle(preset=preset_id, palette=100))
        assert np.isfinite(out).all() and out.min() >= -1e-6 and out.max() <= 1 + 1e-6
        assert export_enhance.parse_settings({"recipeVersion": 2, "photoStyle": {"preset": preset_id}}).photo_style.preset == preset_id
    # Styles that existed before keep their exact values so saved edits render unchanged.
    assert {k: editing.PRESETS["warm"][k] for k in ("temperature", "brilliance", "highlights", "vibrance", "contrast")} == \
        {"temperature": .18, "brilliance": .06, "highlights": -.1, "vibrance": .08, "contrast": .04}
    assert editing.PRESETS["mono"]["saturation"] == -1 and editing.PRESETS["mono"]["contrast"] == .14
    rose = editing.apply_style(np.full((4, 4, 3), .5, np.float32), export_enhance.PhotoStyle(preset="rose_gold", palette=100))
    assert rose[0, 0, 1] < rose[0, 0, 0]  # tint reaches the CPU path (magenta: less green)

import numpy as np
import pytest

from server import editing, export_enhance


@pytest.mark.parametrize("angle", [0, 12, -15])
@pytest.mark.parametrize("sharpen", [0, .75])
def test_native_tiles_match_full_export_pipeline(monkeypatch, angle, sharpen):
    source = np.random.default_rng(42).random((193, 257, 3), dtype=np.float32)
    monkeypatch.setattr(export_enhance.db, "fetch_photo", lambda _: {"id": "x"})
    monkeypatch.setattr(export_enhance.queue._loader, "load", lambda _: (source, None, "x"))
    settings = export_enhance.parse_settings({"recipeVersion": 2, "exposure": .4, "shadows": .2,
        "selectedColor": {"center": .67, "hue": .3, "saturation": -.2, "luminance": .4},
        "gradient": {"exposure": -.7, "temperature": .3, "highlights": -.3,
            "start": {"x": .2, "y": .15}, "end": {"x": .7, "y": .8}, "feather": .6, "invert": angle < 0},
        "sharpen": sharpen, "photoStyle": {"preset": "vivid", "palette": 70},
        "crop": {"x": .1, "y": .08, "width": .8, "height": .75, "angle": angle}})
    image = export_enhance.queue._color.apply(source, settings)
    image = export_enhance.queue._style.apply(image, settings)
    image = editing.apply_selected_color(image, settings.selected_color)
    image = editing.apply_gradient(image, settings.gradient)
    full = editing.sharpen_float(np.clip(editing.apply_geometry(image, settings.crop), 0, 1), sharpen)
    h, w = full.shape[:2]
    for x, y in [(0, 0), (17, 21), (w - 15, h - 11)]:
        tile, dimensions = export_enhance.render_detail("x", settings, {"x": x, "y": y, "width": 57, "height": 43})
        assert dimensions == (w, h, x, y)
        np.testing.assert_allclose(tile, full[y:y + 43, x:x + 57], atol=2e-6)
    original, _ = export_enhance.render_detail("x", settings, {"x": 0, "y": 0, "width": 30, "height": 20}, True)
    np.testing.assert_allclose(original, np.clip(editing.apply_geometry(source, settings.crop), 0, 1)[:20, :30], atol=2e-6)


@pytest.mark.parametrize("region", [None, [], {}, {"x": -1, "y": 0, "width": 10, "height": 10},
    {"x": 0, "y": 0, "width": 1537, "height": 10}, {"x": 0, "y": 0, "width": 10.5, "height": 10}])
def test_invalid_regions_rejected_before_decode(monkeypatch, region):
    monkeypatch.setattr(export_enhance.db, "fetch_photo", lambda _: {})
    def no_decode(_):
        pytest.fail("Invalid regions must not decode RAW")
    monkeypatch.setattr(export_enhance.queue._loader, "load", no_decode)
    with pytest.raises(export_enhance.ExportEnhanceError):
        export_enhance.render_detail("x", export_enhance.EnhanceSettings(), region)


def test_engine_versions_roundtrip_and_reject_future_versions():
    for recipe in ({}, {"recipeVersion": 2}):
        parsed = export_enhance.parse_settings(recipe)
        saved = export_enhance.serialize_settings(parsed)
        assert saved["engineVersion"] == saved["rawProfileVersion"] == 1
        assert export_enhance.parse_settings(saved) == parsed
    for key in ("engineVersion", "rawProfileVersion"):
        for value in (2, "1", None, True, [], {}):
            with pytest.raises(export_enhance.ExportEnhanceError, match=key):
                export_enhance.parse_settings({key: value})


def test_engine_v1_golden_colors_remain_stable():
    # Fixed v0.3.1 output, not regenerated from the implementation during the test.
    source = np.array([[[0, .05, .4], [.18, .25, .3], [.6, .8, 1.0]]], np.float32)
    settings = export_enhance.parse_settings({"recipeVersion": 2, "engineVersion": 1,
        "exposure": .3, "brilliance": .2, "temperature": .3, "vibrance": .2,
        "photoStyle": {"preset": "warm", "palette": 65}})
    actual = editing.apply_style(editing.apply_color(source, settings), settings.photo_style)
    np.testing.assert_allclose(actual, [[[.026632259, .091789909, .495700806],
        [.219729736, .303388745, .355078369], [.644212902, .863674641, .988971353]]], atol=2e-7)


def test_optional_model_and_legacy_detail_not_silently_approximated():
    for settings in (export_enhance.EnhanceSettings(ai_denoise=True), export_enhance.EnhanceSettings(upscale=True), export_enhance.EnhanceSettings(recipe_version=1)):
        with pytest.raises(export_enhance.ExportEnhanceError, match="100%"):
            export_enhance.render_detail("x", settings, {})


def test_gradient_mask_inverts_and_source_coordinates_survive_roi():
    gradient = export_enhance.parse_settings({"gradient": {"exposure": -.5}}).gradient
    full = editing.gradient_mask((100, 80), gradient)
    cropped = editing.gradient_mask((35, 20), gradient, (19, 21), (80, 100))
    np.testing.assert_allclose(cropped, full[21:56, 19:39], atol=1e-7)
    np.testing.assert_allclose(full + editing.gradient_mask((100, 80), {**gradient, "invert": True}), 1)
    assert full[0].min() == 1 and full[-1].max() == 0
    source = np.full((100, 80, 3), .5, np.float32)
    result = editing.apply_gradient(source, gradient)
    np.testing.assert_array_equal(result[-1], source[-1])
    assert result[0].max() < .5
    assert editing.apply_gradient(source, {**gradient, "enabled": False}) is source
    for invalid in ({"start": []}, {"start": {"x": .5, "y": .5}, "end": {"x": .5, "y": .5}}, {"feather": float("nan")}):
        with pytest.raises(export_enhance.ExportEnhanceError):
            export_enhance.parse_settings({"gradient": invalid})


def test_selected_color_protects_grays_other_hues_and_wraps_red():
    image = np.array([[[.5, .5, .5], [.1, .1, .8], [.8, .1, .1], [.8, .1, .101], [.8, .101, .1]]], np.float32)
    selected = export_enhance.parse_settings({"selectedColor": {"center": 0, "hue": .5, "luminance": .3}}).selected_color
    result = editing.apply_selected_color(image, selected)
    np.testing.assert_array_equal(result[0, :2], image[0, :2])
    assert result[0, 2, 1] > image[0, 2, 1]
    assert np.max(np.abs(result[0, 3] - result[0, 4])) < .003
    assert export_enhance.parse_settings(export_enhance.serialize_settings(export_enhance.parse_settings({"selectedColor": selected}))).selected_color == selected
    for invalid in ([], {"hue": float("nan")}, {"range": {}}):
        with pytest.raises(export_enhance.ExportEnhanceError):
            export_enhance.parse_settings({"selectedColor": invalid})

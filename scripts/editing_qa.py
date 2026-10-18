"""Generate CPU reference pixels for the real-browser GPU check.

Run: .venv/bin/python scripts/editing_qa.py, then npm run dev in frontend and
open /qa/editing.html. Synthetic fixtures do not replace real DNG inspection.
"""
from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from server import editing, export_enhance

image = np.random.default_rng(3).random((8, 8, 3), dtype=np.float32)
image[0] = np.linspace(0, 1, 8)[:, None]
scenarios = [("neutral", {})]
for key in ("exposure", "brilliance", "highlights", "shadows", "vibrance", "temperature", "contrast", "blackPoint", "dehaze", "saturation", "tint"):
    for value in (-.65, .65):
        scenarios.append((f"{key} {value}", {key: value}))
for preset in editing.PRESETS:
    scenarios.append((preset, {"photoStyle": {"preset": preset, "palette": 75}}))
scenarios.append(("combined", {"exposure": -.3, "brilliance": .25, "highlights": -.3, "shadows": .2,
    "temperature": .25, "tint": -.1, "vibrance": .2, "contrast": .1, "saturation": -.1,
    "blackPoint": .1, "dehaze": .1, "photoStyle": {"preset": "warm", "palette": 60, "tone": 10, "colour": -10}}))
scenarios.append(("style zero", {"photoStyle": {"preset": "mono", "palette": 0}}))
for invert in (False, True):
    for feather in (.05, .6, 1):
        scenarios.append((f"gradient invert={invert} feather={feather}", {"exposure": .2,
            "photoStyle": {"preset": "warm", "palette": 55},
            "gradient": {"start": {"x": .2, "y": .15}, "end": {"x": .8, "y": .9},
                "exposure": -.6, "highlights": -.4, "temperature": .5, "invert": invert, "feather": feather}}))
results = []
for center in (0, .02, 1 / 3, 2 / 3, .98):
    for width in (.02, .25):
        scenarios.append((f"selected hue={center:.2f} range={width}", {"selectedColor": {
            "center": center, "range": width, "hue": .4, "saturation": -.4, "luminance": .3}}))
scenarios.append(("selected plus gradient", {"photoStyle": {"preset": "cool", "palette": 50},
    "selectedColor": {"center": .66, "hue": -.5, "saturation": .4, "luminance": -.3},
    "gradient": {"exposure": -.5, "highlights": -.2, "temperature": .3}}))
for name, controls in scenarios:
    settings = export_enhance.parse_settings({"recipeVersion": 2, **controls})
    out = export_enhance.ColorProcessor().apply(image, settings)
    out = export_enhance.PhotographicStyleProcessor().apply(out, settings)
    out = editing.apply_selected_color(out, settings.selected_color)
    out = editing.apply_gradient(out, settings.gradient)
    results.append({"name": name, "settings": export_enhance.serialize_settings(settings),
                    "expected": np.round(out * 255).astype(np.uint8).ravel().tolist()})
path = Path(__file__).resolve().parents[1] / "frontend/qa/fixtures.json"
path.parent.mkdir(exist_ok=True)
path.write_text(json.dumps({"width": 8, "height": 8, "pixels": image.ravel().tolist(), "scenarios": results}))
print(f"Generated {len(results)} CPU reference scenarios: {path}")

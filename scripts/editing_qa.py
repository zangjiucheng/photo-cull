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
results = []
for name, controls in scenarios:
    settings = export_enhance.parse_settings({"recipeVersion": 2, **controls})
    out = export_enhance.ColorProcessor().apply(image, settings)
    out = export_enhance.PhotographicStyleProcessor().apply(out, settings)
    results.append({"name": name, "settings": export_enhance.serialize_settings(settings),
                    "expected": np.round(out * 255).astype(np.uint8).ravel().tolist()})
path = Path(__file__).resolve().parents[1] / "frontend/qa/fixtures.json"
path.parent.mkdir(exist_ok=True)
path.write_text(json.dumps({"width": 8, "height": 8, "pixels": image.ravel().tolist(), "scenarios": results}))
print(f"Generated {len(results)} CPU reference scenarios: {path}")

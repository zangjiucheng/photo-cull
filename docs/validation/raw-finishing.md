# RAW finishing validation — 2026-10-18

Development branch: `feat/raw-finishing`, based on Windows-support commit `521906c`.
These changes have not been packaged or deployed.

## Automated evidence

- Backend: **106 passed** (`.venv/bin/python -m pytest -q`).
- Frontend: **37 passed**, 6 files (`cd frontend && npm test -- --run`).
- TypeScript and production Vite build pass.
- Native-detail ROI versus full-resolution CPU processing: angles 0°, +12°, −15°; sharpening 0/.75; selected color and local gradient; interior and image-edge tiles. Float32 tolerance **2e-6**. Original comparison uses the same geometry.
- Rejected before decoding: malformed, negative, fractional and oversized regions. Tiles are capped at **1536×1536**. Optional-model and legacy native-detail requests fail explicitly.
- Recipe round trips include engine/profile, selected color and gradient. Unknown engine versions are rejected, and a failed save leaves the previous saved recipe intact. Fixed v0.3.1 golden color values catch unintended engine changes.
- Gradient source coordinates agree between full-image and ROI processing; invert masks sum to one. Selected color protects grays and other hues and remains continuous across red's hue wrap. Relative WB neutralizes a known mild linear cast and rejects clipped/dark picks.
- Cache tests exercise global LRU across separate editor/export caches, the single-oversized-image exception, and cancellation of obsolete prefetch requests (two pending plus one running).

## Browser evidence

Brave on the current Mac, WebGL float textures:

- **60 CPU/GPU scenarios, max difference 0/255**: original 43 controls/styles, 6 gradient directions/feathers, 10 selected-color bands near hue boundaries, and combined style/selected-color/gradient.
- Synthetic 1600×1200 draw plus GPU finish: median **0.10ms**, P95 **1.40ms** in this run. This is a warm renderer microbenchmark, not end-to-end interaction latency or a portable performance guarantee.
- Retina DPR=2: a 1200×900 image displayed at 600×450 CSS pixels; a 1536×1536 DNG detail tile displayed at 768×768 CSS pixels.
- Real local 4000×3000 DJI DNG: native tile loads and arrow-key panning work. Fit view remains fast. No full-resolution source is uploaded to WebGL for detail viewing.
- Verified gradient handles, affected-area overlay, local slider EV labeling, and one keyboard adjustment undone in one step (51% endpoint restored to 50%). A pointer drag moved the endpoint from (50%,20%) to approximately (60.23%,26.44%); one Undo restored (50%,20%). Existing saved gradient survived reload. Color picking selected the synthetic sky at approximately 215°; saturation controls and combined gradient display work.
- UI uses an isolated `/tmp` catalog and copied/synthetic photos. No production catalog or original source photo was edited; photos were not uploaded.

## Boundaries and remaining acceptance

- The histogram samples the edited crop in sRGB before optional model stages; it is not a sensor histogram. Fit detail can differ from native interpolation.
- Native inspection excludes output resize and optional noise reduction/upscale. Those options must be off to enable 100%.
- The **384MiB budget covers resident cached arrays**, not live decoders, CPU work buffers, browser pixels or GPU memory. One 48MP float RGB base alone is roughly 576MB. Tests use smaller arrays to exercise the budget rules, not a real 48MP performance claim.
- Pending prefetch can be canceled; a running rawpy decode cannot be interrupted.
- High-ISO real night scenes, actual 48MP files, long-session total memory, packaged Electron/macOS/Windows workflows, optional-model runtime and user aesthetic acceptance remain **unverified** under **PER-367**. Previous PER-352 was closed by migration, not by declaring these checks passed.

## Reproduce the GPU check

```bash
.venv/bin/python scripts/editing_qa.py
cd frontend
npm run dev -- --host 127.0.0.1
```

Open `/qa/editing.html`, click **Run checks**. If the dev server serves cached source after external file changes, restart it before comparing the generated fixtures to GPU output.

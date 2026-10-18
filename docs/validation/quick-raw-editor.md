# Quick RAW editing: implementation and validation

Implementation date: 2026-10-17 (Toronto). Corresponds to Linear PER-339–PER-352.

## User flow and interface

Add culled photos to the queue from Browse / Review, then enter Enhance & Export: auto enhance → six everyday sliders → export. The everyday controls are Exposure, Brilliance, Highlights, Shadows, Vibrance, and Warmth. Style thumbnails use the current photo; Original, Natural, Warm sunset, Cool, and Black & white each have their own strength.

Hold the compare button or `\` to see the neutral RAW base; double-click a slider to reset it; `Cmd/Ctrl+Z` undoes and `Shift+Cmd/Ctrl+Z` redoes. One drag is one history entry. Reset covers crop and adjustments and keeps export settings. Edit history is limited to 50 steps and belongs to the current session; photo recipes are saved to the database, and saves still pending when the window closes have a local recovery copy. Save failures are shown clearly in the editor and can be retried.

The advanced section contains Contrast, Black point, Dehaze, Saturation, Tint, Detail, and a clipping warning; crop supports common ratios, position, size, ±15° straighten, and a rule-of-thirds grid. After rotation the crop is automatically pulled back inside the valid image area to avoid black edges. Copy, paste, and batch apply can select adjustment groups and by default keep each photo's own exposure, white balance, and crop. Personal presets are stored on the current device; applying a preset also respects the selected groups. Share JPEG / Archive TIFF are built-in export presets.

Interface trade-offs: the photo comes first, the folder sidebar is hidden while editing, with one large photo, an adjustments column on the right, and a selection strip at the bottom. System fonts are used; canvas `#161616`, main background `#191919`, panels `#252525`, separators `#393939`, body text `#f3f3f3`, selection color `#f6cc52`. Photos are centered and fitted; parameter labels are left-aligned and values right-aligned. The first review pass removed the dual preview, the Tone/Colour 2D control, and the manual Render button, reducing the number of operations in the common flow.

```text
Filename                       Undo Redo Reset Folder Export
┌───────────────────────────┬────────────────┐
│                           │ Auto enhance   │
│        Main photo         │ Six sliders    │
│                           │ Style thumbs   │
│                           │ Collapsed adv. │
├───────────────────────────┤                │
│ Hold to compare  Strip    │ Export setup   │
└───────────────────────────┴────────────────┘
```

## Processing pipeline

1. New recipes are `recipeVersion: 2`. RAW is decoded with rawpy to 16-bit linear sRGB, with camera WB and fixed exposure (`no_auto_bright=True`), then converted to float32 encoded sRGB. LibRaw's default highlight clipping policy is kept; signal already saturated on the sensor cannot be recovered. Warmth/Tint are linear RGB adjustments relative to the camera white balance, and do not claim to be an absolute Kelvin re-development.
2. Exposure and relative warmth are computed in linear light; light/dark and styles use explicit display-luminance math. Preset parameters come from `server/editing_presets.json`, shared by CPU and GPU. The neutral zero point is the identity, with no default sky/foliage tinting.
3. The main editing image is passed as float32 RGB data to a persistent WebGL texture; browse thumbnails use fast JPEGs separately. Sliders update uniforms without reloading the photo, compiling shaders, or creating textures. Destroying an instance releases its GPU resources; when WebGL is unavailable, a backend preview is requested automatically.
4. The backend decode cache is invalidated by path, mtime ns, size, and rotation, and holds at most two entries / 384 MiB (one entry is kept if a single photo exceeds the limit). Browser requests can be cancelled and results carry their photo/recipe ownership, so old responses cannot overwrite new settings. Backend previews stay in memory and do not accumulate temporary JPEGs.
5. Old unversioned recipes are kept as version 1 and continue to use the old algorithm. The interface offers an explicit switch; switching to the new controls starts from neutral and can be undone. Unedited queued photos use defaults separately, so the current photo's parameters are not applied by accident.
6. Regular resizing, sharpening, and geometry stay in floating point; JPEG is quantized to 8 bits only at final write, and TIFF to 16 bits only at final write. The ICC is the output tag for a genuine sRGB working result. 8-bit inputs with an ICC profile are converted to sRGB via LittleCMS. 16-bit TIFFs written by Photo Cull can be re-read without loss of precision; other 16-bit TIFF profiles are currently rejected explicitly, to avoid silently reducing bit depth.
7. JPEG / TIFF embed an sRGB ICC, update Orientation=1, dimensions, and software name, and keep supported camera, exposure, date, and author tags. The safe Exif IFD for TIFF is appended without changing the 16-bit pixels. GPS, XMP, MakerNote, and RAW-specific offsets are not copied. Filenames are de-duplicated automatically and originals are never overwritten.
8. Noise reduction is accurately called traditional noise reduction, and the runtime reports OpenCV non-local means or the Pillow fallback. Noise reduction and Real-ESRGAN are independent optional steps that go through an 8-bit image and are off by default. Real-ESRGAN requires the optional runtime; this round did not download new models or claim AI RAW denoising.

## Validation evidence

- Python: 75 tests pass. Covers the API, real float transfer and invalidation on source changes, RAW 16-bit decode parameters, precision beyond 256 levels, JPEG/TIFF ICC and Exif, gradient resizing and sharpening, crop without black edges, legacy recipes, non-finite values, noise-reduction fallback, and more.
- Frontend: 19 tests pass; the TypeScript + Vite production build passes. New recipe tests cover the auto-strength zero point, selective copy, isolation of white balance/exposure/crop, and deep copy.
- Real Mac / Brave WebGL: 30 synthetic CPU/GPU pixel comparisons show a maximum difference of 0/255 after display quantization. For a 1600×1200 preview, 60 draws waiting for the GPU to finish took a median of 0.20 ms and P95 of 5.60 ms. This only reflects draw time on this machine, not end-to-end drag latency on every machine.
- Manual browser flow: one-step undo after continuous dragging, redo, auto enhance at strength 0, per-photo parameter isolation, reload after database save, and export of three queued JPEGs were verified; undo/redo, 16:9 crop, and straighten on real RAWs were also run. Testing found and fixed an empty state overwriting recipes while the workspace loaded, and black style thumbnails caused by the first GPU draw happening before resources were initialized.
- Real samples: 24 DJI FC3170 DNGs, 4000×3000, from an existing local folder, used read-only, covering daylight, backlight, water, sunset, city, and forest. All developed successfully; first decode median 1.59 s, max 2.42 s. A contact sheet of the five styles after auto enhance was checked, with no default local tinting or obvious global anomalies. This is a preliminary visual check, not user aesthetic approval or a full quality rating.
- One real DNG was fully exported as a 4000×3000 uint16 TIFF, with dimensions and ICC verified. Its downscaled export compared with the same-recipe preview: mean absolute error 0.00053/255, P99 0.00192/255, max about 10.18/255 (a few edge resampling differences). Interpolation, detail, and noise reduction at different resolutions are not guaranteed to be pixel-identical.
- The original DNGs' sizes and modification times were unchanged before and after. Samples, contact sheets, and test exports stayed in `/tmp`; nothing was written to production photo folders or uploaded to Linear.
- The PyInstaller backend build and run pass, explicitly including rawpy and the shared style JSON so packaging doesn't miss resources. The standalone binary, in an isolated test database, actually returned a 1600×1200 float32 RAW base and completed a three-DNG export (per-photo settings, one cropped 3994×2247 uint16 TIFF, two JPEGs); reading back the TIFF's ICC, Exif IFD, and Orientation=1 passed. The full Electron distribution and the optional AI runtime still need separate acceptance testing.

## Reproduction

Python 3.11 is verified. After installing requirements-dev.txt, run `.venv/bin/python -m pytest -q`; in frontend run `npm test` and `npm run build`.

GPU comparison: run `.venv/bin/python scripts/editing_qa.py` to generate a git-ignored fixture, then in frontend run `npm run dev -- --host 127.0.0.1`, open `http://127.0.0.1:5173/qa/editing.html`, and click Run checks. This page is a development test entry only and is not part of the production build.

## Not yet covered

PER-352 stays in acceptance: real high-ISO night scenes, 48 MP DNGs, long-term memory during large batches of continuous photo switching, the full Electron package, the optional model runtime, and the user's aesthetic choice of final styles are not all covered yet. The P0/P1/P2 feature implementation is recorded separately from the tested scope above, and synthetic tests are not used in place of these conditions.

# Mavic Air 2: research and redesign proposal for quick RAW editing

First research draft: 2026-10-17. The source-code issues below describe the state before the redesign. The user then authorized implementation in dependency order; the quick editing features and a preliminary check on 24 real DJI DNGs are done. Implementation details, evidence, and conditions still to be covered are in the [implementation and validation record](../validation/quick-raw-editor.md).

Development is tracked in the [Linear project: Photo Cull — Quick RAW editing](https://linear.app/jiucheng-zang/project/photo-cull-快速-raw-调色-396f85133d41), with three milestones (P0/P1/P2) and 14 tasks, PER-339 to PER-352, each with priority, dependencies, and acceptance criteria. The project is in implementation; task status and verification results are kept in sync in Linear.

The [full research document in Linear](https://linear.app/jiucheng-zang/document/mavic-air-2-快速调色研究交互与验收方案-d0b37490126c) keeps a separate copy of this research.

## Confirmed usage goals

- Camera: DJI Mavic Air 2, usually shooting single RAW frames.
- Keep the existing scoring and duplicate detection; editing is the focus of this round.
- After culling, finish editing and export in this app, without going into Lightroom.
- Most current filters are unsatisfying; the goal is quick adjustment with a few simple drags, like Apple Photos.

Proposed product path: **cull → auto enhance → drag a few sliders → export**. The first version concentrates on a natural, controllable, instant editing experience.

## Issues confirmed in the source code

| Location | Current implementation | What it means for the redesign |
| --- | --- | --- |
| `server/raw_pipeline.py:139` | Full RAW decoding explicitly uses `output_bps=8` and converts to `uint8` | Data is quantized before any floating-point processing. Keep the 16-bit decode first, then convert to floating-point working data |
| `server/export_enhance.py:517` | TIFF is written at 16 bits, but its input comes from the chain above; resizing and sharpening also go through 8-bit PIL | File bit depth cannot recover input precision that was already lost; the whole chain needs checking |
| `server/export_enhance.py:198` | Simple exposure, per-channel gains, and repeated clipping on display RGB | Define the working color space, RAW white balance, and highlight handling explicitly; don't treat simple brightening as full RAW development |
| `server/export_enhance.py:350` | With `standard` and tone/colour at zero, sky and foliage tinting still runs; the default palette is 100 | Add a strictly neutral "Original" base. Zero adjustments must not quietly change colors |
| `server/export_enhance.py:249` | Sky and foliage are judged mainly by color rules; the optional model hook targets people | Blue water, blue roofs, warm ground, etc. may be misclassified; the real error rate still needs sample photos. Default editing should not depend on these masks |
| `frontend/src/components/workspaces/ExportEnhanceWorkspace.tsx:117` | The GPU shader does not implement the shadow/highlight tint from the backend presets | Even with the same input image, preview and export algorithms do not fully match |
| Same file `:198` | The effect depends on style, so every parameter change rebuilds the Image, program, shader, and texture; cleanup only marks things disposed | Keep GPU resources and only update uniforms while dragging; actual frame rate and VRAM impact are not yet measured |
| `server/export_enhance.py:684` | The backend preview uses `full_raw=False` while export jobs use the full RAW | The preview may come from the embedded in-camera JPEG while export re-develops the RAW; risk of tone, white balance, and detail differences |
| `server/export_enhance.py:479` | "AI Denoise" is actually OpenCV non-local means or a PIL filter | Label it accurately as "Noise reduction" first; not core to quick editing in this round |
| `server/export_enhance.py:517` | Export passes no explicit ICC profile; the TIFF branch also doesn't write the EXIF already obtained | Add an output color-management and metadata policy so finished photos display correctly |

These issues explain the limits of the current design, but they do not yet prove which one causes each "unusable filter" the user mentioned; that needs reproduction on real photos.

## What to borrow from Apple Photos' interaction

The key patterns Apple officially describes are: adjust after automatic analysis, a few basic controls, expandable fine-tuning, per-control reset, and temporarily turning effects off. Brilliance combines light/dark handling and contrast, which reduces how many controls the user has to touch. These are interaction patterns and target effects worth borrowing; they do not mean Apple's unpublished algorithms can be copied. [Apple adjustment guide](https://support.apple.com/en-il/guide/photos/pht806aea6a6/mac)

Proposed editing area: the large photo on the left, a narrow adjustments column on the right, and thumbnails of the selected photos along the bottom. One main preview shows the final result; rendering status is shown as a light hint.

Recommended order of operations:

1. Open a photo and get a neutral RAW base preview.
2. Click "Auto enhance"; a strength slider can weaken the effect.
3. Adjust a few everyday sliders as needed.
4. Hold to compare with the original; left/right keys go to the next photo, and settings save automatically.
5. Choose an export preset and produce the finished photos in a batch.

### Six everyday sliders on the first screen

| Control | User intent | Implementation notes |
| --- | --- | --- |
| Exposure | Overall a bit brighter or darker | Process in a well-defined working space; don't clip highlights early |
| Brilliance | Clearer shadows, more open overall | Combine light/dark and moderate local contrast; control halos and noise amplification |
| Highlights | Bring clouds and sky back | Distinguish darkening for display from recovering highlights that still have data in the RAW |
| Shadows | See the ground and buildings | Keep the black point; don't force night scenes and silhouettes to gray |
| Vibrance | Nicer colors | Restrain already-saturated colors; avoid over-blue skies and fluorescent green foliage |
| Warmth | Quickly change the mood | Map to RAW white balance parameters; avoid faking it with a display-RGB color cast |

"More" then holds Dehaze, Contrast, Black point, Tint, Detail, and Noise reduction. Dehaze is a worthwhile addition for aerial photos, but it should be optional and adjustable, leaving room for creative hazy scenes. Adobe also documents it for atmospheric haze and some low-contrast photos. [Dehaze guide](https://helpx.adobe.com/lightroom-classic/desktop/help/tone-control-adjustment.html)

Results show directly while dragging, with no extra click on Render Preview. Double-click a slider to reset it; support undo/redo, reset all, and per-item toggles. One drag creates only one undo entry, so continuous events don't flood the history.

## What auto enhance should do

Start with an explainable, adjustable parameter suggester: read the image distribution and propose conservative changes to exposure, light/dark, white balance, and vibrance; the result lands on the same sliders and can be undone.

- Daytime, sunset, and night scenes use different constraints; don't push everything to the same average brightness.
- Keep light correction separate from style; "Auto" does not apply strong color casts by default.
- Keep usable highlight information from the RAW; fully saturated areas are not promised to recover real texture.
- Auto strength controls the effect through bounded parameter mapping, guaranteeing that zero strength returns to the pre-auto state.
- The first version needs no large-model training. First verify whether parameter suggestions reduce the actual number of operations.

## How to rebuild the filters

Demote the current Tone/Colour 2D pad to an optional feature; the main flow uses explicit sliders. Start with just a few candidate styles such as "Original, Natural & clear, Warm sunset, Cool, Black & white", generate thumbnails from the current photo, and provide an independent 0–100 strength.

Filters should be based on a single developed result, followed by reviewable curves and color transforms; do not add blue to every blue area or green to every green area by default. Names like "Natural & clear" are product names still to be tuned and must not be treated as a validated Mavic Air 2 camera profile. Apple Photos filters also offer adjustable strength, which is worth borrowing. [Apple filter guide](https://support.apple.com/en-ie/guide/photos/phte0af949f0/12.0/mac/27)

## Implementation order

| Phase | Scope | Acceptance target |
| --- | --- | --- |
| P0: quality and consistency | High-bit-depth RAW processing, neutral defaults, unified parameters and processing order, same input for preview/export, output ICC | Zero adjustments are reproducible; a downscaled export shows no obvious tonal deviation from the main preview; the 16-bit path never goes through 8 bits early |
| P1: quick adjustments | Auto enhance, six everyday sliders, instant preview with resource reuse, compare to original, autosave and undo | Continuous dragging doesn't stutter or flash back to old results; one drag is one undo; settings persist across photo switches and restarts |
| P1: a few reliable styles | Leaner rebuilt filters, photo thumbnails, independent strength | Zero strength does not change the base; no obvious abnormal color casts across many kinds of aerial photos |
| P2: finishing | Crop and straighten, dehaze, copy/selective paste of adjustments, personal presets, export presets | A complete single-photo flow can be done in this app; batch style sync can keep each photo's own exposure and crop |
| Later | Manual gradient/brush local adjustments, then evaluate smart sky/ground masks | Masks can be viewed and corrected; confusable areas like water and sky are validated separately |

Scoring and duplicates stay; AEB/HDR, panoramas, maps, and Lightroom integration are lower priority given current habits. Real-ESRGAN already exists; this round's resources go first to basic finished-photo quality.

## Technical route and where changes land

In the short term, continue the current rawpy + NumPy + WebGL architecture and close the small P0/P1 loop first. rawpy officially provides 16-bit output, white balance, exposure, and highlight-related parameters, but this project pins version 0.26.1, so the specific parameter behavior must be verified on that version. [rawpy parameters](https://letmaik.github.io/rawpy/api/rawpy.Params.html)

- `server/raw_pipeline.py`: separate browse thumbnails from the editing base, keep high-bit-depth decoded data, define development parameters and cache keys.
- `server/export_enhance.py`: split base development, auto parameter suggestions, styles, and output; keep neutral defaults; make ICC, bit depth, and metadata policies explicit.
- `frontend/src/components/workspaces/ExportEnhanceWorkspace.tsx`: organize the workflow around one main preview and an adjustments column, initialize GPU resources once, and only update the needed state when parameters change.
- `frontend/src/App.tsx`, `frontend/src/types.ts`, `server/db.py`: extend and version each photo's edit recipe, save settings for existing photos, and define undo, reset, and batch-paste semantics.
- GPU and CPU use the same preset data and math definitions; do numeric and image comparisons on the same base pixels, to avoid maintaining two quietly different effects.

If this route can't reach acceptable quality on real DNGs, compare darktable CLI as an internal development engine on a few sample photos. The official CLI supports headless export, history/styles, and ICC options; users could still operate only this app. The cost is more complex packaging, version compatibility, startup, and parameter mapping, so migrating directly is not recommended for now. [darktable CLI](https://docs.darktable.org/usermanual/5.6/en/special-topics/program-invocation/darktable-cli/)

The recommended default output is sRGB JPEG, with 16-bit TIFF also offered for archiving. The working space and output space must be converted explicitly, not just tagged. darktable documents that the output profile should take part in the conversion and be embedded in the file so other applications can interpret the colors. [Output color management](https://docs.darktable.org/usermanual/5.6/en/module-reference/processing-modules/output-color-profile/)

## What evidence decides "easy to use"

Later implementation builds a small sample set from about 20–30 of the user's real Mavic Air 2 DNGs, covering daylight, backlight, sunset glow, fog, and night, as well as sky/water/foliage/buildings. These photos have not been obtained yet, so no claim is made that filter results are validated.

- Quality: look at cloud gradients, highlights, shadow noise, foliage color, building edges, and water; check detail at 100%.
- Consistency: compare the same photo side by side in the main preview, the backend render, and a downscaled export; explain differences in terms of color space and scaling.
- Operation: record the time and number of operations from opening to a satisfying result, and how many controls still need adjusting after auto enhance.
- Performance: on a real Mac, measure drag latency, resource use during long drags, first RAW load, and photo switch time. Preliminary targets are about 30 fps for everyday slider interaction after warm-up and visible feedback within about 50 ms; these are design targets, not yet measured.
- Output: check tone in macOS Preview, browsers, and the user's actual sharing devices, and check ICC, pixel dimensions, and bit depth.

The minimum viable redesign should deliver: **a neutral RAW base + auto enhance + six sliders + a consistent instant preview + correct export**, and then use real photos to decide which styles to keep.

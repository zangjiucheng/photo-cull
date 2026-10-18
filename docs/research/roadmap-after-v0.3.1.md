# Research: priorities after v0.3.1

Research date: 2026-10-18. This is a proposal, not a feature implementation or a scheduled release.

## Baseline and live status

The product goal remains a short workflow for DJI Mavic Air 2 single RAW photos: cull, edit, and export locally, without a second editing application.

- Published application: [v0.3.1](https://github.com/zangjiucheng/photo-cull/releases/tag/v0.3.1), commit `ffe737c0ce6e7e80942ffa1e4c5ec919c6b599e1`. Its Release and CI workflows succeeded.
- At the first check, `main` was `bc0ca2d`, with later documentation and MIT license changes. Its CI succeeded. The [project website](https://zangjiucheng.github.io/photo-cull/) returned HTTP 200.
- Downloaded the actual v0.3.1 arm64 DMG: 121,909,538 bytes. SHA-256 matched both the release manifest and GitHub's asset digest: `6bd2a63ab11f27466b4c9858971c8bdc6941be22d5e6d7a7d1d9ee44b7c3294d`. `hdiutil verify` passed. This verifies download integrity, not a complete installed-app interaction test.
- The observed local test run passed 84 Python tests and 28 frontend/Electron-helper tests. This is source-level evidence, not a new comprehensive image-quality evaluation.
- Linear contained 17 project issues: 16 Done and [PER-352](https://linear.app/jiucheng-zang/issue/PER-352) In Review. High-ISO night scenes, 48 MP inputs, long-session memory, optional model runtime, and the complete desktop workflow matrix remain incomplete.
- Additional uncommitted platform/shortcut work appeared while researching. It was left untouched and is not counted as a released capability. Findings below target the v0.3.1 editing architecture.

Already delivered: ratings and similarity groups; versioned per-photo edits; camera-WB high-bit-depth RAW development and embedded DNG tone curve; Auto without repeated stacking; adaptive Tone/Color pad; 18 looks; persistent GPU rendering and shared style thumbnails; adjacent-photo prefetch and separate export caches; crop/straighten; selective copy and device presets; JPEG/16-bit TIFF output; checksum-verified in-app updates; documentation, website and release automation.

## Findings from the code

| Evidence | Consequence |
| --- | --- |
| `server/routes.py:editing_base` always requests a 1600 px longest-edge base. The Enhance canvas fits that image. | A large/full-screen view cannot reliably judge original-resolution noise, focus, sharpening or small fringes. Review has zoom relative to fit size; that does not provide a processed RAW 1:1 view in Enhance. |
| `ExportEnhanceSettings` contains global controls, crop, Auto, pad and style, but no user-editable local adjustment list or selected-color controls. | Improving a bright sky without changing the ground, or changing greens without affecting other colors, is still difficult. Legacy heuristic mask code is not an editable v2 masking workflow. |
| Workspace entry files store folder references; recipes live in SQLite and personal presets in localStorage. | Saving a workspace entry does not back up edits or presets. Moving machines/disks needs explicit recovery and relinking. |
| `JobQueue._jobs` is an in-memory dictionary. | Export failures are recorded during the process, but job history/recovery does not survive backend restart. |
| RAW development applies an embedded curve and `BASE_EXPOSURE_EV = 0.6`; recipes distinguish v1/v2 but do not pin a complete base-engine/profile revision. | Future base or preset changes need explicit rendering-version semantics to keep old edits reproducible. The fixed lift is a tuning choice, not proof of camera-JPEG or Lightroom equivalence. |
| Editor/export full-resolution caches have separate budgets, and prefetch is queued on an executor. | Sustained rapid switching and large RAWs need a combined memory budget and stale-prefetch control. One 48-megapixel RGB float32 array alone is about 576 MB, excluding decode buffers and processing temporaries. This is a capacity estimate, not a measured crash. |

## Recommended sequence

### Gate 0: finish image-quality and reliability acceptance

Continue PER-352 against the current engine. Use day, backlight, sunset, haze, dark city/night, water, foliage and high-contrast architecture; add genuine 48 MP samples when available. Inspect original/Auto/manual/style/export at original resolution. Record the actual end-to-end task time, RAW load, rapid switching and combined editor/export memory over a long session. Keep user aesthetic acceptance separate from CPU/GPU mathematical parity.

Add engine/base-profile revisions to saved recipes and output provenance before the next rendering change. Preserve the old rendering path or require an explicit upgrade. Build a small, consented regression corpus with saved outputs and stated tolerances. Compare camera JPEG and another trusted renderer as references, without treating their appearance as the only correct result.

### 1. Native 100% detail inspection and a small histogram — highest immediate value

User flow: click a building/treetop to inspect it at 1:1, drag to pan, then return to Fit. Optional synchronized before/after and clipping overlay should show the same region.

Implementation: keep the current 1600 px path for ordinary editing; request an original-resolution processed region/tile only for detail inspection. Preserve crop/rotation mapping and filter padding at region edges. Define 1:1 against physical display pixels on Retina displays. A histogram can use a sampled processed image and be throttled after slider movement.

Acceptance: the displayed region matches the corresponding full-size export region; panning never shows another photo's result; Fit remains fast; GPU texture limits do not require uploading a complete 48 MP image. Label whether the histogram reflects the current crop and treat it as a display/output histogram rather than a RAW sensor histogram.

Adobe's documented workflow switches from smart previews to originals at 100% zoom. This is useful precedent for a fast-fit/full-detail split, not a requirement to copy Lightroom's architecture. [Source](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-options.html)

### 2. One simple linear-gradient local adjustment — greatest new editing capability

User flow: drag down from the sky, reduce Exposure/Highlights, adjust feather, optionally invert; the ground stays largely unchanged. Keep this in a collapsed Local section. Start with a manually positioned gradient; add brush or automatic sky refinement after the basic interaction is proven.

Implementation: normalized source-image coordinates, bounded control values, visible mask overlay, enable/disable/delete, undo grouping, and a versioned local-adjustment recipe. Establish an explicit processing order and implement the same mask math in CPU and GPU. Initial local controls can be Exposure, Highlights and Warmth.

Acceptance: soft transitions remain consistent after crop/rotation and export; the user can see and correct the affected region. A gradient can also affect buildings above the horizon, so it must not be described as an accurate sky segmentation. [Adobe masking reference](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/masking.html)

### 3. Targeted color adjustment and a white-balance picker

User flow: click foliage to make green less intense, or select blue to deepen a sky. Start with Hue/Saturation/Luminance and a soft range control in an advanced panel; offer an eyedropper for sampling. A separate neutral-color picker can suggest relative Warmth/Tint while preserving the existing camera-WB base.

Implementation: continuous hue interpolation, low-saturation safeguards, identical CPU/GPU transforms, undo/preset/copy support. A true Kelvin/tint RAW redevelopment would be a separate larger pipeline change; do not relabel current RGB multipliers as Kelvin.

Acceptance: avoid banding at hue-range boundaries and extreme changes to near-gray pixels. The same blue range may affect both water and sky; spatial restriction needs the local-mask foundation. Apple Photos exposes Hue, Saturation, Luminance and Range for selected colors. [Source](https://support.apple.com/en-gu/guide/photos/phtcafe645b6/mac)

### 4. Recoverable editing projects, presets and exports — parallel reliability work

Add an explicit Backup/Restore action containing database/recipes, personal presets and engine versions, with a manifest explaining whether originals are included. Use SQLite's backup API for a consistent database snapshot, atomic writes, a schema version and migration validation. Support relinking moved photo roots with a file fingerprint check instead of silently binding edits to an unrelated same-name file.

Add named per-photo snapshots/virtual versions for comparing two looks without duplicating RAW files. Persist export manifests with the recipe snapshot, completed outputs and failures; offer retry-failed/resume after restart without overwriting existing output. Preset rename/delete/import/export belongs here too.

Acceptance: restore into a fresh app-data directory and recover ratings, queue, crops, edits and presets. Distinguish catalog backup from actual photo backup, as Adobe also does. [Backup reference](https://helpx.adobe.com/lightroom-classic/desktop/manage-catalogs-and-files/back-catalog.html)

### 5. Faster composition and coherent flight-session batches

Composition: draggable crop edges/center and a two-point horizon tool can replace repeated position/size slider adjustments while preserving the existing crop recipe. Add automatic horizon suggestions only after manual geometry is reliable on mountains, water and slanted buildings.

Batches: let the user choose a reference photo and preview bounded per-photo exposure adjustments for a selected same-scene group. Preserve individual crops/WB unless explicitly selected. Do not equalize unrelated day/night scenes or override intentional silhouettes. Adobe's Match Total Exposures is an exposure-metadata-based precedent; it is not automatic semantic color matching. [Source](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-options.html)

### Later: optics, denoising and distribution polish

- **Lens correction / defringe / perspective:** first audit actual Mavic Air 2 DNG metadata and existing LibRaw behavior, then validate whether corrections are already applied. Avoid double correction or a fabricated camera-specific profile. Compare corners, straight lines and high-contrast edges at 1:1. [Adobe optics reference](https://helpx.adobe.com/lightroom/web/edit-photos/apply-effects/apply-optics.html)
- **Improved denoising:** evaluate on genuine night/high-ISO files after the detail viewer exists. Separate chroma and luminance behavior; protect small foliage/building detail. Investigate high-bit-depth or RAW-aware processing before adding another model to the existing 8-bit optional path.
- **Developer ID signing/notarization:** worthwhile if distributing beyond personal use; requires Apple developer identity/credentials and is a separate decision. Existing checksum verification does not establish Developer ID trust.
- **Culling improvements:** synchronized 1:1 comparison in a duplicate group and uncertainty explanations can follow the detail viewer. Preserve non-destructive decisions and avoid automatic deletion.

## Suggested scope for the next product iteration

Recommended user-facing scope: **Fit/100% detail view + histogram + one linear-gradient tool**. Add targeted color after those are stable. Run recipe-versioning, backup/recovery and PER-352 acceptance alongside the user-facing work.

Defer additional filter packs, generative sky replacement, large model training, cloud sync, panorama and HDR merge for now. The user normally shoots single RAWs; the missing value is precise finishing and confidence in saved/exported work. This prioritization is an engineering/product inference from the stated workflow and the code audit, not a measured user-study result.

No new feature code, release tag or implementation issues were created during this research. Test fixtures and downloaded release assets remained outside the repository.

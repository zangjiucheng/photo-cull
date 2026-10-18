# PER-367 acceptance run — 2026-10-18

Branch under test: `feat/raw-finishing` at `590f690`. Nothing in this run changed product code. PER-367 carries over the PER-352 conditions that were never met. This record lists what could actually be measured on this machine and marks the rest **pending**. The earlier 24 daytime DNGs and the synthetic tests count only as prior evidence.

## Environment

- MacBook Pro M1 Pro, 16 GB, macOS (Darwin 27.0). Python 3.11.13 repo venv for direct pipeline runs. The packaged backend was built with Homebrew Python 3.13 and PyInstaller. Electron 30.5.1.
- `.venv` has no OpenCV, so noise reduction in direct runs and in the packaged PyInstaller backend uses the **Pillow fallback**. `requirements-package.txt` does not include OpenCV. The optional AI runtime venv does include it (see below).
- Catalog: every run used a copy of the user's library DB in a scratch directory (`DB_PATH`, `UPLOAD_FOLDER`, and for Electron `--user-data-dir`). Before and after the run, the real DB and `backend.log` had the same size and mtime. The sizes and mtimes of all 105 vancouver2026 and 48 Montreal source files were also unchanged.
- Backend tests on this commit: `106 passed`.

## Sample inventory (what exists on this Mac)

`/Volumes/MacDisk` holds **526 RAW files, all DNG, all DJI FC3170, all 4000×3000 (12.0 MP)**. `/Volumes/FrameTank` is not mounted.

| Property | Result |
|---|---|
| Camera models | FC3170 only |
| Max resolution | 12.0 MP. **No file ≥ 40 MP** |
| ISO ≥ 1600 or exposure ≥ 0.5 s | **None** |
| Highest ISO | 830 (one file). Only one file is ≥ 800. 406 files are ISO 100 |
| Low-light candidates used below | Banff Day4-5 `DJI_0029/0030/0032/0035` (21:34–21:37 dusk, ISO 690–760, 1/8–1/6 s), Elmira `DJI_0183/0184/0189` (19:50 dusk, ISO 590–830, 1/10–1/8 s), vancouver2026 `DJI_0282` (ISO 460) |

These are **dusk, moderate-ISO files from a 1/2.3" sensor**. They are not high-ISO night scenes. The checks below stress the shadows and noise of real files, but they do not satisfy the night-scene condition.

## 1. Real-sample quality checks (low-light proxies)

The pipeline is the real code: `ImageLoader._decode` (rawpy 16-bit linear → DJI profile tone curve +0.6 EV → float32 sRGB), then `editing.auto_adjustments` on the 512 px copy, `editing.apply_color` and `apply_style` at full resolution, `AIDenoiseEngine` low/medium/high, and a full-size JPEG through `ExportWriter`. There were 9 files: 8 low-light and 1 ISO 100 daylight reference (`DJI_0177`).

- **Non-finite values:** 0 in every base, auto, styled, and denoised array (9 files × 9 variants).
- **Sensor clipping:** 0–0.05 % of raw pixels at white level, except `DJI_0035` at 2.3 % (sky). Base highlight clipping (any channel ≥ 0.999) was 0–1.3 %, and 7.4 % for `DJI_0035`. Auto brought `DJI_0035` to 0.0 % (`highlights −0.2`). Auto stayed conservative on all dusk files: exposure ≤ +0.35 EV and no shadow lift. The one exception is `DJI_0035` (median Y 0.10), which took the night branch: exposure 0, shadows +0.05.
- **Banding:** 8-bit histograms of the auto output have 0–8 empty codes inside the occupied range per channel. That is ordinary 8-bit quantization, not a comb. I checked a 1:1 sky crop of `DJI_0032` (dusk sky). Its float output has 340k–373k distinct values per channel, the largest step in the row-averaged vertical profile is 2.1/255, and the exported JPEG stretched ×10 shows only sensor noise, with no contour bands. The blotchy skies in the downscaled contact sheet come from thumbnailing, not from the pipeline.
- **Colour cast:** near-neutral pixels average R−G −1 to −3.5 and B−G −3 to +2.4 (8-bit units) on both dusk and daylight files. Shadows (Y < 0.1) lean slightly green or cyan, with R−G −1.5 to −8. The daylight reference shows the same −3.8, so the lean is not specific to low light. I can't tell scene content apart from cast without a reference target, so this is recorded, not judged.
- **Noise:** I estimated flat-area luma noise with Immerkær, 10th-percentile 16 px block, in 8-bit units. ISO 450–830 dusk files measure **1.5–1.9**, against **0.68** for ISO 100 daylight. Shadow noise measures 1.2–2.5. Pillow-fallback NR medium cuts luma noise by about 53 % and chroma noise by about 49 %. It also cuts the 95th-percentile texture energy by the same ~53 %. The fallback is a uniform smoother, not edge-aware, and it takes 3–4.5 s per 12 MP image. With the AI-runtime venv, the same call uses OpenCV non-local means (7–9.5 s per 12 MP image, no non-finite values). A 1:1 crop showed visibly cleaner chroma with modest softening.
- **Styles:** Bright, Warm Sunset, and B&W behaved. **Dramatic** sends 14–59 % of pixels to a zero channel on the dusk frames (base 0.3–6.5 %), and it reads as crushed black foreground in the contact sheet. That is a strong look on low-light frames, not a numerical fault. It needs a decision at aesthetic sign-off.
- **Timing and memory (12 MP):** a clean single-process decode takes **0.8–2.2 s** (first read from USB disk is slowest). Under 3-way parallel load it takes 2.2–4.3 s. **The peak RSS of one decode is about 1.13 GB above baseline, roughly 8× the 137 MiB result.** One full process ran decode, auto, three NR strengths, four styles, and JPEG export with a peak RSS of 1.35–1.87 GB.
- **48 MP estimate (not a measurement):** linear scaling gives roughly 4.5 GB transient per decode and a 576 MB resident base. Editor prefetch can run one decode while a request decodes another, so on a 16 GB Mac that would approach 9 GB. This is a risk to measure with real files. It does not count as evidence.

Evidence (scratch, not committed): `.../scratchpad/accept/quality/contact_sheet.png`, `crops_1to1.png`, `sky_banding.png`, `quality.json`, `inventory.json`.

## 2. Long-session backend memory

I ran `python app.py` (repo venv, DB copy) on a free port and drove it over HTTP the way the editor does on every photo switch: `editing-base` (1600 px float), `prefetch` of the next and previous photos, `style-pad`, `auto-adjustments`, `export-enhance/preview` (rotating styles), one 1024×768 `editing-detail` tile, and a recipe `PUT`. The run made 9 passes over all 105 vancouver2026 DNGs, **945 photo switches**, in two driver runs against the same process. A 20-photo full-size JPEG batch export ran in each run, alongside the open editor caches. HTTP errors: 0. Export failures: 0 of 40.

| Phase | RSS median | RSS max | phys_footprint median | footprint max |
|---|---|---|---|---|
| Run 1 pass 1 / 2 / 3 | 1147 / 1116 / 1174 MB | 1793 / 1733 / 1845 MB | (not sampled) | |
| Run 1 export (20 JPEG, 27.4 s) | 1361 MB | 1741 MB | | |
| Run 2 pass 1–6 | 1130–1250 MB | 1779–1833 MB | 1141–1622 MB | 1739–1811 MB |
| Run 2 export (20 JPEG, 29.6 s) | 1271 MB | — | 1662 MB | **2015 MB** |
| Idle after run 2 | — | — | 547–733 MB | |

**Result: memory plateaus.** Over 945 switches it stays in the same 1.0–1.8 GB band with no upward drift between pass 1 and pass 9, and it returns to about 550 MB when idle. The 384 MiB budget holds the resident caches as designed, and the idle footprint stays above it as expected (scaled copies, masks, and interpreter). The working peak is about 5× the budget, from transient decode buffers (one request decode plus one prefetch decode). That is consistent with the documented boundary that the budget "covers resident cached arrays, not live decoders". Note that `ps` RSS is misleading on macOS: it fell to 12–113 MB while idle because pages were compressed. Use `footprint` for this check.

Latency over 945 switches, measured with the background work below running: `editing-base` median 0.76 s, P95 1.54 s. `detail` median 0.18 s. `preview` median 0.11 s. `style-pad` median 0.09 s.

Charts: `.../scratchpad/accept/session2/rss_all.png` (both runs) and `footprint_chart.png`.

Caveats: this is an API-level session. It does not include the Chromium renderer or GPU memory. Unbounded but tiny: `JobQueue._jobs` is never pruned (`server/export_enhance.py:842`), so each export job keeps its output list for the life of the process.

## 3. Packaged macOS app

`make package-dir PYTHON=/opt/homebrew/bin/python3.13` built `release/mac-arm64/AI Photo Culling.app` (unsigned). I launched the binary with `DB_PATH=<copy>`, `AI_CULLING_DISABLE_UPDATES=1`, `FLASK_PORT=5193`, `--remote-debugging-port=9333`, and `--user-data-dir=<scratch>`. I drove it with Playwright `connectOverCDP` and looked at a screenshot after each step.

`UPLOAD_FOLDER` from the environment is ignored by Electron. `main.cjs:379` always uses `userData/uploads`. So `--user-data-dir` is required to keep the backend log, uploads, and Local Storage off the real profile, and with it in place the real `backend.log` stayed untouched.

| Step | Result |
|---|---|
| Launch → launcher lists the 4 workspaces from the DB copy | Pass |
| Open vancouver2026 → Browse grid | Pass |
| Rate DJI_0379 2★ (was 4★) | Pass (DB `rating=2`) |
| Queue DJI_0379 | Pass (position 71 of 72) |
| Enhance & Export, open DJI_0379 | Pass. Real DNG renders in WebGL2 with float render targets |
| Drag Tone/Color pad up-right | Pass. Contrast 0.11, Vibrance 0.23, Saturation 0.07 and others moved; saved as `pad.tone 0.5, colour 0.6` |
| Pick Warm Sunset | Pass. Recipe `photoStyle.preset = "warm"`, "Edits saved" |
| Export 3 photos (queue reduced to 0379, 0352 [legacy v1 recipe], 0342 [no recipe]) to scratch | Pass. 3 × 4000×3000 JPEG in 14 s, sRGB ICC, Orientation 1, no GPS |
| Quit (app menu quit) → backend child exits | Pass. No orphan process |
| Relaunch with same DB copy | Pass. 0379 shows 2★, queue is exactly 0379/0352/0342, 0379 sliders and Warm Sunset restored, pad dot restored |

Found during this flow:

- **Bug: legacy (v1) recipe exports drop all capture metadata.** `DJI_0352_enhanced.jpg` has no Make/Model/ISO/exposure, while the v2 exports keep them. `ImageLoader.load_legacy` returns `exif=None` for RAW (`server/export_enhance.py:447-449`). The UI promises that "Camera, exposure, date and author metadata are retained". Repro: `POST /api/export-enhance/jobs` with `settings: {}` (recipeVersion 1) for any DNG, then read Exif tag 272 of the output, which is missing.
- UX: **Clear queue** empties a 72-photo queue in one click with no confirmation or undo (`ExportEnhanceWorkspace.tsx:1972-1978` → `App.tsx:358`).
- UX: the export **Folder** field is React state only (`App.tsx:73`) and is blank after restart.

Screenshots: `.../scratchpad/accept/desktop/shots/01-launch.png` through `09c-recipe-after-restart.png`.

Not covered: real "import" through the native Open Folder dialog, because CDP cannot drive the macOS file dialog and an existing workspace was opened instead. Also not covered: DMG/zip install, Gatekeeper on an unsigned build, auto-update, and Windows.

## 4. Optional model runtime

An AI runtime **is already installed** in the real profile: `ai-runtime/installed.json` from 2026-05-01, Python 3.13.13 venv with torch 2.11 (MPS available), OpenCV 4.13, pyiqa, open_clip, faiss, and `RealESRGAN_x2.pth`. There are no x4 weights. Nothing was installed or downloaded.

- Direct run of this commit's code in that venv (`-I -B`, model directory copied to scratch): OpenCV NLM works on 12 MP (7–9.5 s). Real-ESRGAN ×2 on a 1000×750 crop took 10.5 s on MPS with no non-finite values. The output has typical GAN texture: painterly roof shingles and brick, visible at 1:1.
- Packaged app with the runtime: I symlinked the runtime into the scratch `userData` with `PYTHONDONTWRITEBYTECODE=1`. The app then started `ai-runtime/venv/bin/python runtime-source/app.py`. A one-photo export with NR medium reported "Noise reduction: OpenCV non-local means" and took 6.4 s.
- **Bug, severe: Real-ESRGAN ×2 on a single 12 MP export drove the backend to a phys_footprint of 18–22 GB on this 16 GB Mac.** It finished after 292 s with an 8000×6000 JPEG, heavy swap, and **19 GB still held after the job finished**, until the app quit. `RealESRGANEngine.apply` (`server/export_enhance.py:753-757`) passes the whole frame to the vendored `RealESRGAN.predict`. That function uploads every patch to the device at once and grows the output with repeated `torch.cat`, and nothing caps input size or releases the MPS cache afterwards. Repro: packaged app with the runtime installed, then export one 12 MP DNG with `upscale: true, upscaleScale: 2` and watch `footprint -p <backend pid>`.
- Status: **partially verified**. The runtime launches, and denoise and ×2 upscale run end to end. Upscale is not acceptable for real 12 MP or 48 MP use as it stands. x4 was not tested because the weights are absent and fetching them would download.

## Pending (PER-367 conditions still unverified)

| Condition | Status | Why |
|---|---|---|
| Real high-ISO night scenes | **Pending** | No file on this Mac has ISO ≥ 1600 or a long night exposure. The max is ISO 830 at dusk, and every file is a 1/2.3" DJI. The dusk results above are proxies only. Needs real night RAWs (ideally from more than one camera) |
| 48 MP RAWs | **Pending** | No file ≥ 40 MP is available. `/Volumes/FrameTank` is not mounted. Memory figures for 48 MP above are extrapolations, and the prefetch-plus-decode peak (~9 GB est.) needs measuring |
| Long-session memory | **Verified for 12 MP backend only** | Plateau over 945 switches and 2 batch exports. Still pending: renderer/GPU memory in the packaged app over a long session, and 48 MP sessions |
| Full desktop import/edit/export/restart | **Mostly verified on macOS (unpacked build)** | Pending: native folder-picker import, signed/DMG install, Windows. One metadata bug found (legacy export) |
| Optional model runtime | **Partially verified; blocked by upscale memory bug** | Existing install works for NR and small upscales. Full-frame ×2 upscale uses 18–22 GB. x4 untested |
| User aesthetic sign-off | **Pending** | Only the user can give it. Items to look at: Dramatic on dusk frames, GAN texture from Real-ESRGAN, and the slight green shadow lean |

## Follow-up on `feat/library-recovery`

Fixed after this run (covered by tests in `tests/test_export_enhance.py` and `tests/test_recovery.py`):

- **Legacy (v1) RAW exports now keep capture metadata.** `ImageLoader.load_legacy` reads the source Exif for RAW files like the v2 path does.
- **Real-ESRGAN upscaling runs in overlapping tiles** (512 px tiles, 16 px overlap; only the tile centre is kept), so model memory depends on the tile size instead of the photo. A pixel-exact stand-in model confirms tiled output equals a whole-frame pass. The real ×2 model was **not** re-run on 12 MP here to avoid swapping the user's Mac again; the memory figure still needs re-measuring with the runtime.
- **Clear queue** asks for confirmation when more than one photo is queued.
- **The export folder** is remembered per workspace on this device.
- **Finished export jobs** leave the in-memory cache; they persist in the library database and are reloaded on demand.

Still open from this record: high-ISO night scenes, 48 MP files and memory, renderer/GPU memory over a long session, native folder-picker import, signed/DMG install and Windows desktop acceptance, Real-ESRGAN ×2 memory re-measure and ×4, and the user's aesthetic sign-off (Dramatic on dusk frames, GAN texture, slight green shadow lean).

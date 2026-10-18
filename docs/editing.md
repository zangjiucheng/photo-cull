# Editing

The **Enhance & Export** workspace is a quick RAW editor for the photos in your export queue. The intended flow is short: **Auto → drag the pad or a few sliders → export**.

![The editor: large photo, filmstrip, and the Adjust panel](../site/assets/editor.webp)

## Layout

- **Top bar**: filename and position in the queue, **Undo**, **Redo**, **Reset**, **Folder...** (output folder), and **Export N**, the only primary button.
- **Canvas**: the edited photo, **Hold for original** (or hold `\`), and **Full screen**.
- **Filmstrip**: the queued photos. Click one to edit it; the previous and next photos are prefetched in the background.
- **Adjustments column**: Adjust, Styles, Light & color, Crop & straighten, Copy adjustments & presets, Noise reduction & upscale, Export.
- **Status bar**: save state (edits save automatically) and **Clear queue**.

## The starting point: DNG tone curve

DJI DNGs carry a `ProfileToneCurve`, the same curve the in-camera JPEG and Lightroom use. The editor develops the RAW at 16 bits with camera white balance, lifts it by +0.6 EV, and applies that curve while preserving hue, so a photo at zero adjustments already looks close to the camera's JPEG rather than flat and gray. DNGs without an embedded curve develop as before.

## Auto

**Auto** analyzes the photo and sets conservative values on the regular sliders: a small exposure correction (none for night scenes), highlight protection when highlights approach clipping, a shadow touch only when the darks are crushed, and a little Brilliance and Vibrance. **Auto strength** scales the suggestion; at zero you are back to the pre-Auto state. Clicking Auto again replaces the previous suggestion instead of stacking on it.

## Tone/Color pad

The square pad at the top of **Adjust** is an Apple Photos-style 2D control:

- Vertical: **More Tone** (up) ↔ **Softer** (down). Moves Contrast, Black point, Shadows, Highlights, and Brilliance.
- Horizontal: **Muted** (left) ↔ **Vivid** (right). Moves Vibrance and Saturation.

The pad doesn't add a hidden layer; it moves the real sliders, so everything it does can be fine-tuned afterwards, and dragging the pad again keeps your fine-tuning. The directions are computed per photo from its histogram and skin/sky detection: shadows that are already deep aren't pushed further, highlights near clipping are protected first, and skies and skin get less saturation.

Double-click the pad to reset it. When it has keyboard focus, arrow keys nudge it (hold `Shift` for bigger steps).

## Sliders

Everyday sliders under the pad: **Exposure** (±3 EV), **Brilliance**, **Highlights**, **Shadows**, **Vibrance**, **Warmth**.

**Light & color** (collapsed by default): **Contrast**, **Black point**, **Dehaze**, **Saturation**, **Tint**, **Definition**, and **Show clipping (red / blue)**.

Double-click any slider to reset it. One drag is one undo step. Warmth and Tint are relative to the camera white balance, not Kelvin values.

## Styles

Styles are grouped like Apple Photos and each one is previewed on the current photo:

- **Undertones**: Standard, Amber, Gold, Rose Gold, Neutral, Cool Rose — shift the colour cast.
- **Moods**: Vibrant, Natural, Luminous, Dramatic, Quiet, Cozy, Ethereal, Warm Sunset, Cool — change tone and colour together.
- **Black & White**: Classic B&W, Muted B&W (soft), Stark B&W (high contrast).

**Style strength** blends the style from 0 to 100. Standard is a strict identity: it doesn't tint skies or foliage. Styles are applied on top of your slider adjustments and render identically in the live preview and in exports.

## Crop & straighten

Opening this section shows a rule-of-thirds grid. Pick **Original**, **1:1**, **4:3**, **3:2**, **16:9**, or **9:16**, then set **Straighten** (±15°), **Crop size**, and **Horizontal / Vertical position**. After rotation the crop is kept inside the image so no black corners appear. **Reset crop** clears it. Cropping is non-destructive.

## Copy adjustments & presets

Choose which groups to copy: **Light**, **Color**, **Style**, **Detail**, **Exposure**, **Warmth**, **Crop**, **Export settings**. Then:

- **Copy** / **Paste** between photos.
- **Apply to queue** applies the selected groups to every queued photo.
- Save the current look as a personal preset ("Name this look"). Presets are stored on this device and also respect the selected groups.

By default each photo keeps its own exposure, white balance, and crop.

## Noise reduction & upscale

Optional and off by default. Noise reduction is a traditional filter (OpenCV non-local means, or a Pillow fallback) with Low / Medium / High strength. Upscaling (2× or 4×) uses Real-ESRGAN and needs the optional AI runtime. Both run through an 8-bit image.

## Export

- Presets: **Share JPEG** and **Archive TIFF**.
- **Format**: JPEG · sRGB or TIFF · 16-bit sRGB. **JPEG quality**. **Longest edge**: original resolution, 2048, 2560, or 3840 px.
- **Folder**: the destination.

Export uses each photo's own saved recipe, embeds an sRGB ICC profile, keeps camera, exposure, date, and author metadata, and omits GPS, XMP, and MakerNote. Existing filenames are never overwritten, and originals stay intact. Export settings are per photo too; copy the **Export settings** group to sync them across the queue.

## Undo, reset, and history

- `⌘Z` undo, `⇧⌘Z` redo (`Ctrl` works too). History holds up to 50 steps per session.
- **Reset** clears adjustments and crop but keeps export settings.
- Recipes are saved to the local database; if a save is still pending when the window closes, a local recovery copy is kept.

## Legacy recipes

Recipes saved before v0.2.0 (v1) keep the legacy engine and show **Legacy edit preserved**. **Use new controls** switches the photo to the current base and starts from neutral; undo restores the old recipe.

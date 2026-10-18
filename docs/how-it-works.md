# How it works

Technical notes on RAW development, colour, output and performance. For day-to-day use see [Editing](editing.md).

## RAW, color, and output

- New (v2) recipes develop RAW with rawpy at 16 bits, fixed exposure, and camera white balance, then keep float32 for the base processing. DJI DNGs with an embedded `ProfileToneCurve` go through it with a +0.6 EV lift and hue-preserving application. DNGs without a tone curve develop as before.
- GPU preview and CPU export share the style data and adjustment math. Browse thumbnails still use fast previews.
- Warmth is relative to the camera white balance, not a Kelvin re-development. Highlights cannot recover detail that is clipped on the sensor.
- Resizing, sharpening, and cropping stay in floating point; output is quantized to 8 bits for JPEG and 16 bits for TIFF only at the final write. Preview and full-size export can differ slightly in interpolation and detail.
- Output embeds an sRGB ICC profile, keeps supported camera, exposure, date, and author metadata, and updates orientation and size. GPS, XMP, and MakerNote are not copied.
- v1 recipes from before v0.2.0 keep the legacy engine and show **Legacy edit preserved**; **Use new controls** switches to the new base and starts from neutral (undo brings the old recipe back).
- Noise reduction is a traditional filter (OpenCV non-local means, or a Pillow fallback); Real-ESRGAN upscaling needs the optional runtime. Both are off by default and run through an 8-bit image when enabled.
- 16-bit TIFFs written by this app can be re-imported at full precision; other 16-bit TIFFs with other ICC profiles aren't supported yet.

## Performance

From the [v0.3.0 notes](releases/v0.3.0.md): switching back to an opened photo takes about 0.01 s instead of about 2.7 s, preview rendering about 0.09 s instead of 0.7 s, and a batch export of 3 full-size JPEGs about 3.5–4.7 s instead of about 12–13.6 s, with identical output pixels.

## Validation status

Initial checks used 24 DJI FC3170 4000×3000 DNGs. High-ISO real night scenes, 48 MP RAWs, memory use over long sessions, and the optional model runtime are not fully validated yet. Details are in the [validation record](validation/quick-raw-editor.md).

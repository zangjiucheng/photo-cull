"""Version 2 editing math. The matching shader lives in frontend/src/editing.

Arrays are float32, encoded sRGB. Exposure and relative warmth operate in linear
sRGB; tone controls operate on display luminance. No 8-bit intermediate buffers.
"""
from __future__ import annotations

import json
import math
import os
import threading
import struct
from fractions import Fraction
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import numpy as np
from PIL import Image, ImageCms

PRESETS = json.loads(Path(__file__).with_name("editing_presets.json").read_text())
SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
# PIL releases the GIL while resampling, so the three channel planes resize in parallel.
_RESIZE_POOL = ThreadPoolExecutor(max_workers=3, thread_name_prefix="resize")


_PIXEL_WORKERS = min(8, os.cpu_count() or 4)
_PIXEL_POOL = ThreadPoolExecutor(max_workers=_PIXEL_WORKERS, thread_name_prefix="pixels")
_IN_PIXEL_POOL = threading.local()


def per_pixel(fn):
    """Run a purely per-pixel function over row bands in parallel for large images.

    NumPy releases the GIL inside large ufuncs, so bands run concurrently; because every pixel
    is computed independently the result is bit-identical to a single call.
    """
    def band(part, args):
        _IN_PIXEL_POOL.active = True
        try:
            return fn(part, *args)
        finally:
            _IN_PIXEL_POOL.active = False

    def run(image, *args):
        # Nested per-pixel calls (apply_color -> decode_srgb) run inline: submitting to the same
        # pool from its own workers would deadlock once every worker waits on a nested band.
        if (getattr(_IN_PIXEL_POOL, "active", False) or image.ndim < 2
                or image.shape[0] * image.shape[1] < 1_000_000):
            return fn(image, *args)
        bands = np.array_split(image, _PIXEL_WORKERS, axis=0)
        return np.concatenate(list(_PIXEL_POOL.map(band, bands, [args] * len(bands))), axis=0)
    run.__wrapped__ = fn
    run.__doc__ = fn.__doc__
    return run


def channel_max(image):
    # Elementwise over channel views is ~10x faster than a reduction over the last (stride-3) axis
    # and gives bit-identical results.
    return np.maximum(np.maximum(image[..., 0], image[..., 1]), image[..., 2])


def channel_min(image):
    return np.minimum(np.minimum(image[..., 0], image[..., 1]), image[..., 2])


@per_pixel
def encode_srgb(linear):
    return np.where(linear <= 0.0031308, linear * 12.92,
                    1.055 * np.maximum(linear, 0) ** (1 / 2.4) - 0.055).astype(np.float32)


@per_pixel
def decode_srgb(rgb):
    return np.where(rgb <= 0.04045, rgb / 12.92,
                    ((np.maximum(rgb, 0) + 0.055) / 1.055) ** 2.4).astype(np.float32)


# rawProfileVersion=1: retain this appearance for existing recipes. This is a tuned base,
# not a promise of camera-JPEG/Lightroom equivalence. New profiles need a separate version.
BASE_EXPOSURE_EV = 0.6


@per_pixel
def apply_profile_tone(linear, curve):
    """Apply a linear-in/linear-out DNG tone curve while preserving hue (RGB-tone style).

    The max and min channels go through the curve and the middle channel keeps its relative
    position between them, so saturated skies do not shift hue the way per-channel curves do.
    """
    # RAW input is 16-bit, so a 16-bit lookup table is exact enough and much faster than interp.
    lut = np.interp(np.linspace(0, 1, 65536), curve[:, 0], curve[:, 1]).astype(np.float32)
    linear = np.clip(linear, 0, 1)
    high, low = channel_max(linear), channel_min(linear)
    high_out = lut[(high * 65535 + .5).astype(np.uint16)]
    low_out = lut[(low * 65535 + .5).astype(np.uint16)]
    scale = np.where(high - low > 1e-6, (high_out - low_out) / np.maximum(high - low, 1e-6), 0)
    return (low_out[..., None] + (linear - low[..., None]) * scale[..., None]).astype(np.float32)


@per_pixel
def apply_color(image, settings):
    def value(key):
        return float(getattr(settings, key, 0))
    out = image.astype(np.float32)
    if value("exposure") or value("temperature") or value("tint"):
        linear = decode_srgb(out) * 2 ** value("exposure")
        linear *= np.array([2 ** (value("temperature") * .28),
                            2 ** (-value("tint") * .20),
                            2 ** (-value("temperature") * .28)], dtype=np.float32)
        out = encode_srgb(linear)
    y = out @ LUMA
    shadows = (1 - np.clip(y, 0, 1)) ** 3
    highlights = np.clip(y, 0, 1) ** 3
    # Luminance masks preserve hue and make the two ends independently editable.
    delta = (value("shadows") * shadows + value("highlights") * highlights) * .30
    delta += value("brilliance") * (.20 * shadows - .12 * highlights + .05 * np.sin(np.clip(y, 0, 1) * math.pi))
    out = out + delta[..., None]
    out = (out - .5) * (1 + value("contrast") * .65) + .5
    out = (out - value("black_point") * .12) / max(.1, 1 - value("black_point") * .12)
    # Conservative global haze contrast; this is deliberately not a depth model.
    out = (out - value("dehaze") * .06) * (1 + value("dehaze") * .12)
    gray = out @ LUMA
    sat = channel_max(out) - channel_min(out)
    factor = (1 + value("saturation")) * (1 + value("vibrance") * (1 - np.clip(sat * 1.5, 0, 1)))
    out = gray[..., None] + (out - gray[..., None]) * factor[..., None]
    return np.clip(out, 0, 1).astype(np.float32)


def apply_style(image, style):
    preset = PRESETS.get(style.preset, PRESETS["standard"])
    if style.palette <= 0 or (style.preset == "standard" and not style.tone and not style.colour):
        return image.copy()
    # Preset files use the frontend's camelCase names; apply_color reads snake_case.
    controls = {("black_point" if key == "blackPoint" else key): val
                for key, val in preset.items() if key not in ("label", "group")}
    controls["contrast"] += style.tone / 100 * .15
    controls["temperature"] += style.colour / 100 * .12
    styled = apply_color(image, SimpleNamespace(**controls))
    return (image + (styled - image) * style.palette / 100).astype(np.float32)


def resize_float(image, max_edge):
    height, width = image.shape[:2]
    scale = min(1, max_edge / max(height, width))
    if scale == 1:
        return image
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    def plane(c):
        source = Image.fromarray(np.ascontiguousarray(image[..., c], dtype=np.float32), "F")
        return np.asarray(source.resize(size, Image.Resampling.LANCZOS))
    return np.stack(list(_RESIZE_POOL.map(plane, range(3))), axis=-1).astype(np.float32)


def orient_array(image, orientation):
    if orientation == 2: return np.fliplr(image)
    if orientation == 3: return np.rot90(image, 2)
    if orientation == 4: return np.flipud(image)
    if orientation == 5: return np.swapaxes(image, 0, 1)
    if orientation == 6: return np.rot90(image, -1)
    if orientation == 7: return np.flip(np.swapaxes(image, 0, 1), (0, 1))
    if orientation == 8: return np.rot90(image)
    return image


def sharpen_float(image, amount):
    if not amount:
        return image
    padded = np.pad(image, ((1, 1), (1, 1), (0, 0)), mode="edge")
    blur = sum(padded[y:y + image.shape[0], x:x + image.shape[1]] * weight
               for y, x, weight in [(0, 0, 1), (0, 1, 2), (0, 2, 1), (1, 0, 2), (1, 1, 4),
                                    (1, 2, 2), (2, 0, 1), (2, 1, 2), (2, 2, 1)]) / 16
    return np.clip(image + (image - blur) * amount, 0, 1).astype(np.float32)


def geometry(width, height, crop):
    cw, ch = crop["width"] * width, crop["height"] * height
    cx, cy = (crop["x"] + crop["width"] / 2) * width, (crop["y"] + crop["height"] / 2) * height
    angle = math.radians(crop["angle"])
    c, s = math.cos(angle), math.sin(angle)
    factor = min(1, 2 * min(cx, width - cx) / (abs(c) * cw + abs(s) * ch),
                 2 * min(cy, height - cy) / (abs(s) * cw + abs(c) * ch))
    return max(1, round(cw * factor)), max(1, round(ch * factor)), cx, cy, c, s


def apply_geometry(image, crop):
    if crop == {"x": 0, "y": 0, "width": 1, "height": 1, "angle": 0}:
        return image
    h, w = image.shape[:2]
    ow, oh, cx, cy, c, s = geometry(w, h, crop)
    affine = (c, -s, cx - c * ow / 2 + s * oh / 2,
              s, c, cy - s * ow / 2 - c * oh / 2)
    return np.stack([np.asarray(Image.fromarray(image[..., channel], "F").transform(
        (ow, oh), Image.Transform.AFFINE, affine, Image.Resampling.BICUBIC)) for channel in range(3)], axis=-1)


@per_pixel
def apply_selected_color(image, selected):
    """One smooth circular hue band in HSL; low-chroma colors are protected."""
    if not selected or not any(selected[key] for key in ("hue", "saturation", "luminance")):
        return image
    high, low = channel_max(image), channel_min(image)
    d = high - low
    safe = np.maximum(d, 1e-6)
    r, g, b = image[..., 0], image[..., 1], image[..., 2]
    hue = np.mod(np.where(high == r, (g - b) / safe,
                 np.where(high == g, 2 + (b - r) / safe, 4 + (r - g) / safe)) / 6, 1)
    light = (high + low) / 2
    saturation = d / np.maximum(1 - np.abs(2 * light - 1), 1e-6)
    distance = np.abs(np.mod(hue - selected["center"] + .5, 1) - .5)
    t = np.clip((distance / selected["range"] - .5) * 2, 0, 1)
    chroma = np.clip(d / .08, 0, 1)
    weight = (1 - t * t * (3 - 2 * t)) * chroma * chroma * (3 - 2 * chroma)
    hue = np.mod(hue + selected["hue"] * weight / 6, 1)
    saturation = np.clip(saturation * (1 + selected["saturation"] * weight), 0, 1)
    light = np.clip(light + selected["luminance"] * weight * .25, 0, 1)
    c = (1 - np.abs(2 * light - 1)) * saturation
    x = c * (1 - np.abs(np.mod(hue * 6, 2) - 1))
    z = np.zeros_like(c)
    sector = np.minimum((hue * 6).astype(np.int32), 5)
    out = np.stack([np.choose(sector, choices) for choices in ((c, x, z, z, x, c), (x, c, c, x, z, z), (z, z, x, c, c, x))], axis=-1)
    return np.where(weight[..., None] > 0, out + (light - c / 2)[..., None], image).astype(np.float32)


def gradient_mask(shape, gradient, origin=(0, 0), source_size=None):
    """A manual gradient in normalized oriented-source coordinates, independent of the crop."""
    h, w = shape[:2]
    sw, sh = source_size or (w, h)
    start, end = gradient["start"], gradient["end"]
    dx, dy = end["x"] - start["x"], end["y"] - start["y"]
    x = (np.arange(w, dtype=np.float32) + origin[0] + .5) / sw - start["x"]
    y = (np.arange(h, dtype=np.float32) + origin[1] + .5) / sh - start["y"]
    t = (x[None, :] * dx + y[:, None] * dy) / max(dx * dx + dy * dy, 1e-6)
    t = np.clip((t - .5) / gradient["feather"] + .5, 0, 1)
    weight = 1 - t * t * (3 - 2 * t)
    return 1 - weight if gradient["invert"] else weight


def apply_gradient(image, gradient, origin=(0, 0), source_size=None):
    if not gradient or not gradient["enabled"]:
        return image
    if not any(gradient[key] for key in ("exposure", "highlights", "temperature")):
        return image
    mask = gradient_mask(image.shape, gradient, origin, source_size)[..., None]
    adjusted = apply_color(image, SimpleNamespace(**{key: gradient[key] for key in ("exposure", "highlights", "temperature")}))
    return (image + (adjusted - image) * mask).astype(np.float32)


def auto_adjustments(image):
    """Conservative global suggestions. Keep night scenes dark and sunset WB intact.

    The editing base already carries the camera tone curve, so auto only recovers clipped ends
    and never lifts shadows by default; a flat lift is what made earlier results look washed out.
    """
    y = np.clip(image @ LUMA, 0, 1)
    low, median, high = np.percentile(y, [5, 50, 98])
    night = median < .12
    exposure = float(np.clip(math.log2(.42 / max(median, .01)) * .35, -.35, .35)) if not night else 0.0
    return {"exposure": exposure, "brilliance": .04 if night else .08,
            "highlights": -.2 if high > .92 else (-.08 if high > .85 else 0.0),
            "shadows": .05 if night or low < .04 else 0.0,
            "vibrance": .08 if night else .14, "temperature": 0.0}


PAD_KEYS = ("contrast", "blackPoint", "shadows", "highlights", "brilliance", "vibrance", "saturation")


def style_pad_vectors(image, masks=None):
    """Per-photo directions for the Tone/Color pad, as slider deltas at full deflection.

    Dragging the pad moves the regular sliders along these directions, so the result stays
    fully editable. Directions adapt to the photo: no deeper shadows when they are already
    crushed, highlight protection near clipping, and gentler saturation on skin and large skies.
    masks are the SemanticMaskProvider channels (skin, sky, foliage, background), if available.
    """
    y = np.clip(image @ LUMA, 0, 1)
    low, high = np.percentile(y, [5, 98])
    chroma = float((channel_max(image) - channel_min(image)).mean())
    shadow_room = float(np.clip((low - .02) / .10, 0, 1))
    highlight_room = float(np.clip((.97 - high) / .15, 0, 1))
    chroma_room = float(np.clip((.28 - chroma) / .20, .25, 1))
    skin = sky = 0.0
    if masks is not None:
        skin = float(np.clip(masks[..., 0].mean() * 8, 0, 1))
        sky = float(np.clip(masks[..., 1].mean() * 2.5, 0, 1))
    return {
        "tone": {
            "up": {"contrast": .22, "blackPoint": .25 * shadow_room, "shadows": -.25 * shadow_room,
                   "highlights": .12 * highlight_room - .25 * (1 - highlight_room), "brilliance": -.05},
            "down": {"contrast": -.20, "blackPoint": -.15, "shadows": .20 + .15 * (1 - shadow_room),
                     "highlights": -.15 - .15 * (1 - highlight_room), "brilliance": .15},
        },
        "colour": {
            "up": {"vibrance": .45 * chroma_room,
                   "saturation": .20 * chroma_room * (1 - .7 * skin) * (1 - .5 * sky)},
            "down": {"vibrance": -.35, "saturation": -.35},
        },
    }


def clean_exif(data, width, height):
    """Retain safe capture tags, never copy RAW offsets, thumbnail or GPS pointers."""
    out = Image.Exif()
    if data:
        source = Image.Exif()
        try:
            source.load(data)
            for key in (271, 272, 305, 306, 315, 33432):
                if key in source:
                    out[key] = source[key]
            capture = source.get_ifd(34665)
            safe = {key: capture[key] for key in (33434, 33437, 34855, 36867, 36868, 37377, 37378, 37380, 37383, 37385, 37386, 41989, 42036) if key in capture}
            if safe:
                out[34665] = safe
        except (ValueError, TypeError, OSError, SyntaxError):
            pass
    out[274] = 1
    out[305] = "Photo Cull"
    out[256], out[257] = width, height
    capture = out.get(34665, {})
    capture.update({40961: 1, 40962: width, 40963: height})
    out[34665] = capture
    return out


def attach_tiff_capture(path, exif):
    """Append a small standard Exif IFD to a 16-bit TIFF without touching pixels.

    tifffile reserves ExifOffset, so the writer reserves the adjacent unused tag
    34664 and we replace it with ExifOffset after its target has been written.
    Only the explicitly allowed capture tags from clean_exif are encoded here.
    """
    import tifffile
    with tifffile.TiffFile(path) as tif:
        order = tif.byteorder
        pointer_entry = tif.pages[0].tags[34664].offset
    capture = exif.get(34665, {})
    types = {33434: 5, 33437: 5, 34855: 3, 36867: 2, 36868: 2, 37377: 10,
             37378: 5, 37380: 10, 37383: 3, 37385: 3, 37386: 5, 41989: 3,
             42036: 2, 40961: 3, 40962: 4, 40963: 4}
    entries = []
    for tag, value in sorted(capture.items()):
        dtype = types.get(tag)
        if dtype is None:
            continue
        if dtype == 2:
            data = str(value).encode("ascii", errors="replace") + b"\0"
            count = len(data)
        elif dtype in (5, 10):
            fraction = Fraction(float(value)).limit_denominator(1000000)
            data = struct.pack(order + ("ii" if dtype == 10 else "II"), fraction.numerator, fraction.denominator)
            count = 1
        else:
            data = struct.pack(order + ("H" if dtype == 3 else "I"), int(value))
            count = 1
        entries.append((tag, dtype, count, data))
    with open(path, "r+b") as file:
        file.seek(0, 2)
        if file.tell() % 2:
            file.write(b"\0")
        offset = file.tell()
        external_offset = offset + 2 + len(entries) * 12 + 4
        directory, extra = bytearray(struct.pack(order + "H", len(entries))), bytearray()
        for tag, dtype, count, data in entries:
            directory.extend(struct.pack(order + "HHI", tag, dtype, count))
            if len(data) <= 4:
                directory.extend(data.ljust(4, b"\0"))
            else:
                directory.extend(struct.pack(order + "I", external_offset + len(extra)))
                extra.extend(data)
                if len(extra) % 2:
                    extra.append(0)
        file.write(directory + struct.pack(order + "I", 0) + extra)
        file.seek(pointer_entry)
        file.write(struct.pack(order + "HHII", 34665, 4, 1, offset))

import type { EditingBase } from "./renderer";

export function sampleBase(base: EditingBase, point: { x: number; y: number }) {
  const cx = Math.min(
    base.width - 1,
    Math.max(0, Math.floor(point.x * base.width)),
  );
  const cy = Math.min(
    base.height - 1,
    Math.max(0, Math.floor(point.y * base.height)),
  );
  const rgb = [0, 0, 0];
  let count = 0;
  for (let y = Math.max(0, cy - 2); y <= Math.min(base.height - 1, cy + 2); y++)
    for (
      let x = Math.max(0, cx - 2);
      x <= Math.min(base.width - 1, cx + 2);
      x++
    ) {
      for (let c = 0; c < 3; c++)
        rgb[c] += base.pixels[(y * base.width + x) * 3 + c];
      count++;
    }
  return rgb.map((v) => v / count);
}

export function hueOf(rgb: number[]) {
  const [r, g, b] = rgb,
    high = Math.max(r, g, b),
    low = Math.min(r, g, b),
    delta = high - low;
  if (delta < 0.02) throw new Error("Choose a more saturated color.");
  const hue =
    (high === r
      ? (g - b) / delta
      : high === g
        ? 2 + (b - r) / delta
        : 4 + (r - g) / delta) / 6;
  return ((hue % 1) + 1) % 1;
}

export function neutralWhiteBalance(rgb: number[]) {
  if (Math.min(...rgb) < 0.05 || Math.max(...rgb) > 0.98)
    throw new Error("Choose an unclipped gray surface with some light.");
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  const warmth = Math.log2(b / r) / 0.56;
  const tint = Math.log2(g / Math.sqrt(r * b)) / 0.2;
  return {
    temperature: Math.max(-1, Math.min(1, warmth)),
    tint: Math.max(-1, Math.min(1, tint)),
    limited: Math.abs(warmth) > 1 || Math.abs(tint) > 1,
  };
}

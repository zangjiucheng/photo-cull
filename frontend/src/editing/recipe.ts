import type { ExportEnhanceSettings } from "../types";
import presets from "../../../server/editing_presets.json";

export { presets };
export const quickKeys = [
  "exposure",
  "brilliance",
  "highlights",
  "shadows",
  "vibrance",
  "temperature",
] as const;
export const defaultSettings: ExportEnhanceSettings = {
  recipeVersion: 2,
  exposure: 0,
  brilliance: 0,
  highlights: 0,
  shadows: 0,
  vibrance: 0,
  temperature: 0,
  contrast: 0,
  saturation: 0,
  tint: 0,
  blackPoint: 0,
  dehaze: 0,
  sharpen: 0,
  aiDenoise: false,
  aiDenoiseStrength: "medium",
  upscale: false,
  upscaleScale: 2,
  outputFormat: "jpeg",
  quality: 92,
  resizeMaxEdge: null,
  crop: { x: 0, y: 0, width: 1, height: 1, angle: 0 },
  auto: null,
  photoStyle: { preset: "standard", tone: 0, colour: 0, palette: 100 },
};

export function cloneSettings(
  settings: ExportEnhanceSettings,
): ExportEnhanceSettings {
  return structuredClone({
    ...defaultSettings,
    ...settings,
    recipeVersion: settings.recipeVersion ?? 1,
  });
}

export function geometry(
  width: number,
  height: number,
  crop: ExportEnhanceSettings["crop"],
) {
  const cw = crop.width * width,
    ch = crop.height * height;
  const cx = (crop.x + crop.width / 2) * width,
    cy = (crop.y + crop.height / 2) * height;
  const angle = (crop.angle * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const factor = Math.min(
    1,
    (2 * Math.min(cx, width - cx)) / (Math.abs(c) * cw + Math.abs(s) * ch),
    (2 * Math.min(cy, height - cy)) / (Math.abs(s) * cw + Math.abs(c) * ch),
  );
  return {
    width: Math.max(1, Math.round(cw * factor)),
    height: Math.max(1, Math.round(ch * factor)),
    cx,
    cy,
    c,
    s,
  };
}

export function autoStrength(
  settings: ExportEnhanceSettings,
  strength: number,
) {
  if (!settings.auto) return settings;
  const next = cloneSettings(settings);
  for (const key of quickKeys)
    next[key] =
      settings.auto.base[key] +
      (settings.auto.target[key] - settings.auto.base[key]) * strength;
  next.auto = { ...settings.auto, strength };
  return next;
}

// Re-running auto starts from the pre-auto values, so repeated clicks replace the previous
// suggestion instead of stacking on top of it.
export function applyAuto(
  settings: ExportEnhanceSettings,
  suggestions: Record<string, number>,
) {
  const before = settings.auto ? autoStrength(settings, 0) : settings;
  const base = Object.fromEntries(quickKeys.map((k) => [k, before[k]]));
  const target = Object.fromEntries(
    quickKeys.map((k) => [
      k,
      k === "temperature"
        ? before[k]
        : Math.max(
            k === "exposure" ? -3 : -1,
            Math.min(k === "exposure" ? 3 : 1, before[k] + (suggestions[k] ?? 0)),
          ),
    ]),
  );
  return autoStrength({ ...before, auto: { base, target, strength: 1 } }, 1);
}

export const adjustmentGroups = {
  light: [
    "brilliance",
    "highlights",
    "shadows",
    "contrast",
    "blackPoint",
    "dehaze",
  ],
  color: ["saturation", "vibrance"],
  style: ["photoStyle"],
  detail: ["sharpen", "aiDenoise", "aiDenoiseStrength"],
  exposure: ["exposure"],
  whiteBalance: ["temperature", "tint"],
  crop: ["crop"],
  output: [
    "outputFormat",
    "quality",
    "resizeMaxEdge",
    "upscale",
    "upscaleScale",
  ],
} satisfies Record<string, (keyof ExportEnhanceSettings)[]>;
export type AdjustmentGroup = keyof typeof adjustmentGroups;

export function pasteSettings(
  target: ExportEnhanceSettings,
  source: ExportEnhanceSettings,
  groups: AdjustmentGroup[],
) {
  const copy = cloneSettings(target);
  const values = Object.fromEntries(
    groups
      .flatMap((group) => adjustmentGroups[group])
      .map((key) => [key, structuredClone(source[key])]),
  );
  return { ...copy, ...values, auto: null, recipeVersion: 2 as const };
}

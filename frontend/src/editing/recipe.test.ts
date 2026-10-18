import { describe, expect, it } from "vitest";
import {
  applyAuto,
  applyPad,
  rebasePad,
  autoStrength,
  cloneSettings,
  defaultSettings,
  geometry,
  pasteSettings,
} from "./recipe";

describe("editing recipes", () => {
  it("preserves version 1 edits and deeply separates photo recipes", () => {
    const old = {
      ...defaultSettings,
      recipeVersion: undefined,
      photoStyle: { ...defaultSettings.photoStyle, tone: 22 },
    };
    const copy = cloneSettings(old as unknown as typeof defaultSettings);
    expect(copy.recipeVersion).toBe(1);
    copy.photoStyle.tone = 80;
    copy.crop.x = 0.1;
    expect(old.photoStyle.tone).toBe(22);
    expect(defaultSettings.crop.x).toBe(0);
  });
  it("strength zero restores the exact pre-auto values", () => {
    const settings = cloneSettings(defaultSettings);
    settings.auto = {
      strength: 1,
      base: {
        exposure: 0.3,
        brilliance: 0.1,
        highlights: -0.4,
        shadows: 0,
        vibrance: 0.2,
        temperature: 0.6,
      },
      target: {
        exposure: 0.5,
        brilliance: 0.3,
        highlights: -0.5,
        shadows: 0.1,
        vibrance: 0.3,
        temperature: 0.6,
      },
    };
    const zero = autoStrength(settings, 0);
    expect(zero.exposure).toBe(0.3);
    expect(zero.highlights).toBe(-0.4);
    expect(zero.temperature).toBe(0.6);
    expect(autoStrength(settings, 0.5).exposure).toBe(0.4);
  });
  it("re-running auto replaces the previous suggestion instead of stacking", () => {
    const start = { ...cloneSettings(defaultSettings), exposure: 0.2, shadows: 0.1 };
    const suggestions = { exposure: 0.3, shadows: 0.15, vibrance: 0.1, temperature: 0.5 };
    const once = applyAuto(start, suggestions);
    const twice = applyAuto(applyAuto(once, suggestions), suggestions);
    expect(once.exposure).toBeCloseTo(0.5);
    expect(once.shadows).toBeCloseTo(0.25);
    expect(once.temperature).toBe(0);
    for (const key of ["exposure", "shadows", "vibrance", "temperature"] as const)
      expect(twice[key]).toBeCloseTo(once[key]);
    expect(twice.auto?.base.exposure).toBe(0.2);
    expect(autoStrength(twice, 0).exposure).toBe(0.2);
  });
  it("auto after a manual edit builds on the edited values", () => {
    const edited = { ...applyAuto(cloneSettings(defaultSettings), { exposure: 0.3 }), auto: null, exposure: 1 };
    expect(applyAuto(edited, { exposure: 0.3 }).exposure).toBeCloseTo(1.3);
  });
  it("tone pad moves the sliders, stays editable, and returns to the origin", () => {
    const vectors = {
      tone: { up: { contrast: 0.2, shadows: -0.2 }, down: { contrast: -0.2, shadows: 0.3 } },
      colour: { up: { vibrance: 0.4 }, down: { vibrance: -0.3, saturation: -0.3 } },
    };
    const start = { ...cloneSettings(defaultSettings), shadows: 0.1 };
    const moved = applyPad(start, 1, -0.5, vectors);
    expect(moved.contrast).toBeCloseTo(0.2);
    expect(moved.shadows).toBeCloseTo(-0.1);
    expect(moved.vibrance).toBeCloseTo(-0.15);
    expect(moved.saturation).toBeCloseTo(-0.15);
    // Fine-tuning a slider keeps the dot where it is and is preserved by later drags.
    const tuned = rebasePad({ ...moved, contrast: 0.5 });
    expect(tuned.pad?.tone).toBe(1);
    expect(applyPad(tuned, 1, -0.5).contrast).toBeCloseTo(0.5);
    expect(applyPad(tuned, 0, 0).contrast).toBeCloseTo(0.3);
    expect(applyPad(moved, 0, 0).shadows).toBeCloseTo(0.1);
    expect(applyPad(start, 1, 1)).toBe(start);
  });
  it("selective paste keeps individual exposure, warmth and crop", () => {
    const source = {
      ...cloneSettings(defaultSettings),
      exposure: 1,
      temperature: 0.7,
      contrast: 0.4,
      crop: { x: 0.2, y: 0.2, width: 0.6, height: 0.6, angle: 10 },
    };
    const target = {
      ...cloneSettings(defaultSettings),
      exposure: -0.5,
      temperature: -0.2,
    };
    const pasted = pasteSettings(target, source, [
      "light",
      "color",
      "style",
      "detail",
    ]);
    expect(pasted.exposure).toBe(-0.5);
    expect(pasted.temperature).toBe(-0.2);
    expect(pasted.crop).toEqual(defaultSettings.crop);
    expect(pasted.contrast).toBe(0.4);
    expect(
      pasteSettings(target, source, ["exposure", "whiteBalance", "crop"]).crop,
    ).toEqual(source.crop);
  });
  it("rotated crop fits and keeps the selected aspect", () => {
    const crop = geometry(4000, 3000, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      angle: 12,
    });
    expect(crop.width).toBeLessThan(4000);
    expect(crop.width / crop.height).toBeCloseTo(4 / 3, 3);
    expect(
      Math.abs(crop.c) * crop.width + Math.abs(crop.s) * crop.height,
    ).toBeLessThanOrEqual(4001);
    expect(
      Math.abs(crop.s) * crop.width + Math.abs(crop.c) * crop.height,
    ).toBeLessThanOrEqual(3001);
  });
});

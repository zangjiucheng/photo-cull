import { describe, expect, it } from "vitest";
import {
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

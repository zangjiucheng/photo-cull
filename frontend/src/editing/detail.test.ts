import { describe, expect, it } from "vitest";
import { detailRegion } from "./DetailView";
import { sourcePoint } from "./GradientOverlay";
import { hueOf, neutralWhiteBalance, sampleBase } from "./colorPicker";

describe("native detail and color sampling", () => {
  it("bounds native-pixel regions without scaling or exceeding the texture budget", () => {
    expect(
      detailRegion(4000, 3000, { width: 3000, height: 2000 }, { x: 1, y: 0 }),
    ).toEqual({ x: 2464, y: 0, width: 1536, height: 1536 });
    expect(
      detailRegion(600, 400, { width: 1200, height: 900 }, { x: 0.5, y: 0.5 }),
    ).toEqual({ x: 0, y: 0, width: 600, height: 400 });
  });
  it("maps crop points to oriented source coordinates", () => {
    expect(
      sourcePoint(
        4000,
        3000,
        { x: 0.2, y: 0.1, width: 0.6, height: 0.8, angle: 12 },
        0.5,
        0.5,
      ),
    ).toEqual({ x: 0.5, y: 0.5 });
    const point = sourcePoint(
      4000,
      3000,
      { x: 0.2, y: 0.1, width: 0.6, height: 0.8, angle: 0 },
      0,
      1,
    );
    expect(point.x).toBeCloseTo(0.2);
    expect(point.y).toBeCloseTo(0.9);
  });
  it("averages a bounded neighborhood and rejects ambiguous hue picks", () => {
    expect(
      sampleBase(
        { width: 1, height: 1, pixels: new Float32Array([0.2, 0.4, 0.6]) },
        { x: 1, y: 0 },
      )[2],
    ).toBeCloseTo(0.6);
    expect(hueOf([0, 0, 1])).toBeCloseTo(2 / 3);
    expect(() => hueOf([0.5, 0.5, 0.5])).toThrow("saturated");
  });
  it("proposes relative WB that neutralizes a mild linear cast, with bounds", () => {
    const encode = (v: number) => 1.055 * v ** (1 / 2.4) - 0.055;
    const linear = [0.22, 0.21, 0.18];
    const wb = neutralWhiteBalance(linear.map(encode));
    const corrected = [
      linear[0] * 2 ** (wb.temperature * 0.28),
      linear[1] * 2 ** (-wb.tint * 0.2),
      linear[2] * 2 ** (-wb.temperature * 0.28),
    ];
    expect(corrected[0]).toBeCloseTo(corrected[1], 6);
    expect(corrected[1]).toBeCloseTo(corrected[2], 6);
    expect(wb.limited).toBe(false);
    expect(neutralWhiteBalance([0.9, 0.3, 0.1]).limited).toBe(true);
    expect(() => neutralWhiteBalance([1, 1, 1])).toThrow("unclipped");
  });
});

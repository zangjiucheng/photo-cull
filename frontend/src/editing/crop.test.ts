import { describe, expect, it } from "vitest";
import { cropToView, levelAngle, rotateCrop, viewToCrop } from "./CropOverlay";
import { geometry } from "./recipe";

const W = 4000,
  H = 3000;

describe("crop overlay geometry", () => {
  // geometry() rounds to whole pixels, so allow about a pixel of difference.
  it("round-trips a crop through view coordinates at any angle", () => {
    for (const angle of [0, 4.5, -11]) {
      const view = { x: 0.2, y: 0.15, width: 0.5, height: 0.6 };
      const crop = viewToCrop(W, H, angle, view);
      const back = cropToView(W, H, crop);
      expect(back.x).toBeCloseTo(view.x, 3);
      expect(back.y).toBeCloseTo(view.y, 3);
      expect(back.width).toBeCloseTo(view.width, 3);
      expect(back.height).toBeCloseTo(view.height, 3);
    }
  });

  it("renders a drawn rectangle at exactly that size (no fit shrink)", () => {
    const angle = 8;
    const full = geometry(W, H, { x: 0, y: 0, width: 1, height: 1, angle });
    const crop = viewToCrop(W, H, angle, { x: 0, y: 0, width: 1, height: 1 });
    const win = geometry(W, H, crop);
    expect(win.width).toBeCloseTo(full.width, 0);
    expect(win.height).toBeCloseTo(full.height, 0);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("levels a horizon from two points in either click order", () => {
    // A horizon rising 2% of the height over 50% of the width: about -2.29 degrees.
    const a = { x: 0.25, y: 0.5 },
      b = { x: 0.75, y: 0.48 };
    const expected = (Math.atan2(-0.02 * H, 0.5 * W) * 180) / Math.PI;
    expect(levelAngle(W, H, a, b)).toBeCloseTo(expected, 6);
    expect(levelAngle(W, H, b, a)).toBeCloseTo(expected, 6);
  });

  it("keeps an off-centre crop inside the view when the angle changes", () => {
    const crop = viewToCrop(W, H, 0, { x: 0.3, y: 0.55, width: 0.6, height: 0.45 });
    const rotated = rotateCrop(W, H, crop, -6);
    const rect = cropToView(W, H, rotated);
    expect(rotated.angle).toBe(-6);
    expect(rect.x).toBeGreaterThanOrEqual(-1e-3);
    expect(rect.y).toBeGreaterThanOrEqual(-1e-3);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-3);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-3);
  });
});

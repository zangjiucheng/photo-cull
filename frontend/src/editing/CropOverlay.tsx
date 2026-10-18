import { useRef, useState, type PointerEvent } from "react";
import type { ExportEnhanceSettings } from "../types";
import { geometry } from "./recipe";

type Crop = ExportEnhanceSettings["crop"];
/** A rectangle in normalized coordinates of the crop view (0..1 on both axes). */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_SIZE = 0.05;
const MAX_ANGLE = 15;

/** The whole image at the crop's angle: what the editor shows while cropping. */
export function viewCrop(crop: Crop): Crop {
  return { x: 0, y: 0, width: 1, height: 1, angle: crop.angle };
}

// The crop window shares the view's rotation, so inside the view it is an axis-aligned rectangle.
export function cropToView(width: number, height: number, crop: Crop): ViewRect {
  const view = geometry(width, height, viewCrop(crop));
  const win = geometry(width, height, crop);
  const dx = win.cx - view.cx,
    dy = win.cy - view.cy;
  const w = win.width / view.width,
    h = win.height / view.height;
  return {
    x: 0.5 + (view.c * dx + view.s * dy) / view.width - w / 2,
    y: 0.5 + (-view.s * dx + view.c * dy) / view.height - h / 2,
    width: w,
    height: h,
  };
}

// Inverse of cropToView. A rectangle inside the view always fits the source at this angle, so the
// result renders exactly as drawn (geometry never has to shrink it).
export function viewToCrop(width: number, height: number, angle: number, rect: ViewRect): Crop {
  const view = geometry(width, height, { x: 0, y: 0, width: 1, height: 1, angle });
  const ux = (rect.x + rect.width / 2 - 0.5) * view.width,
    uy = (rect.y + rect.height / 2 - 0.5) * view.height;
  const cx = view.cx + view.c * ux - view.s * uy,
    cy = view.cy + view.s * ux + view.c * uy;
  const cw = Math.min(1, (rect.width * view.width) / width),
    ch = Math.min(1, (rect.height * view.height) / height);
  return {
    x: Math.max(0, Math.min(1 - cw, cx / width - cw / 2)),
    y: Math.max(0, Math.min(1 - ch, cy / height - ch / 2)),
    width: cw,
    height: ch,
    angle,
  };
}

/**
 * Change the angle and keep the crop inside the whole-image view at the new angle (an
 * off-centre crop can otherwise poke outside it), preserving its centre where possible.
 */
export function rotateCrop(width: number, height: number, crop: Crop, angle: number): Crop {
  const rect = cropToView(width, height, { ...crop, angle });
  const scale = Math.min(1, 1 / rect.width, 1 / rect.height);
  const w = rect.width * scale,
    h = rect.height * scale;
  const cx = rect.x + rect.width / 2,
    cy = rect.y + rect.height / 2;
  return viewToCrop(width, height, angle, {
    x: Math.max(0, Math.min(1 - w, cx - w / 2)),
    y: Math.max(0, Math.min(1 - h, cy - h / 2)),
    width: w,
    height: h,
  });
}

/** Angle (degrees) that levels the line through two source points, folded into (-90, 90]. */
export function levelAngle(width: number, height: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  let angle = (Math.atan2((b.y - a.y) * height, (b.x - a.x) * width) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  return angle;
}

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

function resize(start: ViewRect, handle: Handle, dx: number, dy: number, keepAspect: boolean): ViewRect {
  let { x, y, width, height } = start;
  if (handle === "move") {
    x = Math.max(0, Math.min(1 - width, x + dx));
    y = Math.max(0, Math.min(1 - height, y + dy));
    return { x, y, width, height };
  }
  let left = x,
    right = x + width,
    top = y,
    bottom = y + height;
  if (handle.includes("w")) left = Math.max(0, Math.min(right - MIN_SIZE, left + dx));
  if (handle.includes("e")) right = Math.min(1, Math.max(left + MIN_SIZE, right + dx));
  if (handle.includes("n")) top = Math.max(0, Math.min(bottom - MIN_SIZE, top + dy));
  if (handle.includes("s")) bottom = Math.min(1, Math.max(top + MIN_SIZE, bottom + dy));
  if (keepAspect && handle.length === 2) {
    // Keep the starting aspect by fitting the dragged corner to the smaller of the two scales.
    const scale = Math.min((right - left) / width, (bottom - top) / height);
    const w = width * scale,
      h = height * scale;
    if (handle.includes("w")) left = right - w;
    else right = left + w;
    if (handle.includes("n")) top = bottom - h;
    else bottom = top + h;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function CropOverlay({
  base,
  crop,
  leveling,
  onChange,
  onBegin,
  onEnd,
  onLevel,
}: {
  base: { width: number; height: number };
  crop: Crop;
  leveling: boolean;
  onChange: (crop: Crop) => void;
  onBegin: () => void;
  onEnd: () => void;
  /** Called with the two clicked source points; null when the line was too short. */
  onLevel: (points: [{ x: number; y: number }, { x: number; y: number }] | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; start: ViewRect; x: number; y: number } | null>(null);
  const [levelStart, setLevelStart] = useState<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const rect = cropToView(base.width, base.height, crop);

  const local = (event: PointerEvent) => {
    const box = host.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };
  // View coordinates -> normalized source coordinates (the view shows the whole image at this angle).
  const toSource = (point: { x: number; y: number }) => {
    const view = geometry(base.width, base.height, viewCrop(crop));
    const dx = (point.x - 0.5) * view.width,
      dy = (point.y - 0.5) * view.height;
    return { x: (view.cx + view.c * dx - view.s * dy) / base.width, y: (view.cy + view.s * dx + view.c * dy) / base.height };
  };

  const begin = (handle: Handle) => (event: PointerEvent) => {
    if (leveling) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = local(event);
    drag.current = { handle, start: rect, x: point.x, y: point.y };
    onBegin();
  };
  const move = (event: PointerEvent) => {
    const point = local(event);
    if (leveling) {
      setCursor(point);
      return;
    }
    if (!drag.current) return;
    const { handle, start, x, y } = drag.current;
    onChange(viewToCrop(base.width, base.height, crop.angle, resize(start, handle, point.x - x, point.y - y, event.shiftKey)));
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    onEnd();
  };

  const pct = (value: number) => `${value * 100}%`;
  const handles: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  return (
    <div
      ref={host}
      className={`crop-overlay${leveling ? " leveling" : ""}`}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={(event) => {
        if (!leveling) return;
        event.stopPropagation();
        const point = local(event as unknown as PointerEvent);
        if (!levelStart) {
          setLevelStart(point);
          return;
        }
        const long = Math.hypot(point.x - levelStart.x, point.y - levelStart.y) > 0.03;
        onLevel(long ? [toSource(levelStart), toSource(point)] : null);
        setLevelStart(null);
        setCursor(null);
      }}
    >
      {/* Darken everything outside the crop. */}
      <i className="crop-shade" style={{ left: 0, top: 0, width: "100%", height: pct(rect.y) }} />
      <i className="crop-shade" style={{ left: 0, top: pct(rect.y + rect.height), width: "100%", bottom: 0 }} />
      <i className="crop-shade" style={{ left: 0, top: pct(rect.y), width: pct(rect.x), height: pct(rect.height) }} />
      <i className="crop-shade" style={{ left: pct(rect.x + rect.width), top: pct(rect.y), right: 0, height: pct(rect.height) }} />
      <div
        className="crop-frame"
        style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.width), height: pct(rect.height) }}
        onPointerDown={begin("move")}
        role="group"
        aria-label="Crop frame: drag to move, drag edges or corners to resize, hold Shift to keep the shape"
      >
        <span className="crop-thirds" aria-hidden="true">
          <i />
          <i />
          <b />
          <b />
        </span>
        {leveling
          ? null
          : handles.map((handle) => (
              <span key={handle} className={`crop-handle crop-handle-${handle}`} onPointerDown={begin(handle)} />
            ))}
      </div>
      {leveling && levelStart ? (
        <svg className="crop-level-line" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <line
            x1={levelStart.x}
            y1={levelStart.y}
            x2={(cursor ?? levelStart).x}
            y2={(cursor ?? levelStart).y}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}
    </div>
  );
}

export { MAX_ANGLE };

import { useRef } from "react";
import type { ExportEnhanceSettings, LinearGradient } from "../types";
import { geometry } from "./recipe";
import type { EditingBase } from "./renderer";

export function sourcePoint(
  width: number,
  height: number,
  crop: ExportEnhanceSettings["crop"],
  x: number,
  y: number,
) {
  const frame = geometry(width, height, crop);
  const dx = (x - 0.5) * frame.width,
    dy = (y - 0.5) * frame.height;
  return {
    x: Math.max(
      0,
      Math.min(1, (frame.cx + frame.c * dx - frame.s * dy) / width),
    ),
    y: Math.max(
      0,
      Math.min(1, (frame.cy + frame.s * dx + frame.c * dy) / height),
    ),
  };
}

export function GradientOverlay({
  base,
  crop,
  gradient,
  onChange,
  onBegin,
  onEnd,
}: {
  base: EditingBase;
  crop: ExportEnhanceSettings["crop"];
  gradient: LinearGradient;
  onChange: (gradient: LinearGradient) => void;
  onBegin: () => void;
  onEnd: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    active = useRef(false);
  const frame = geometry(base.width, base.height, crop);
  const position = (point: { x: number; y: number }) => {
    const dx = point.x * base.width - frame.cx,
      dy = point.y * base.height - frame.cy;
    return {
      x: (frame.c * dx + frame.s * dy) / frame.width + 0.5,
      y: (-frame.s * dx + frame.c * dy) / frame.height + 0.5,
    };
  };
  const start = position(gradient.start),
    end = position(gradient.end);
  const update = (name: "start" | "end", point: { x: number; y: number }) => {
    const other = gradient[name === "start" ? "end" : "start"];
    if ((point.x - other.x) ** 2 + (point.y - other.y) ** 2 < 1e-5) return;
    onChange({ ...gradient, [name]: point });
  };
  const finish = () => {
    if (active.current) {
      active.current = false;
      onEnd();
    }
  };
  return (
    <div
      ref={host}
      className="quick-gradient-overlay"
      aria-label="Linear gradient handles"
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <svg width="100%" height="100%" aria-hidden="true">
        <line
          x1={`${start.x * 100}%`}
          y1={`${start.y * 100}%`}
          x2={`${end.x * 100}%`}
          y2={`${end.y * 100}%`}
        />
      </svg>
      {(["start", "end"] as const).map((name) => {
        const point = position(gradient[name]);
        return (
          <button
            key={name}
            type="button"
            className="quick-gradient-handle"
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            aria-label={`Gradient ${name === "start" ? "full strength" : "zero strength"} point`}
            title="Drag or use arrow keys"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              active.current = true;
              onBegin();
            }}
            onPointerMove={(event) => {
              if (
                !active.current ||
                !event.currentTarget.hasPointerCapture(event.pointerId) ||
                !host.current
              )
                return;
              const rect = host.current.getBoundingClientRect();
              update(
                name,
                sourcePoint(
                  base.width,
                  base.height,
                  crop,
                  (event.clientX - rect.left) / rect.width,
                  (event.clientY - rect.top) / rect.height,
                ),
              );
            }}
            onPointerUp={finish}
            onPointerCancel={finish}
            onLostPointerCapture={finish}
            onBlur={finish}
            onKeyDown={(event) => {
              const delta = {
                ArrowLeft: [-0.01, 0],
                ArrowRight: [0.01, 0],
                ArrowUp: [0, -0.01],
                ArrowDown: [0, 0.01],
              }[event.key];
              if (!delta) return;
              event.preventDefault();
              event.stopPropagation();
              if (!active.current) {
                active.current = true;
                onBegin();
              }
              update(name, {
                x: Math.max(0, Math.min(1, gradient[name].x + delta[0])),
                y: Math.max(0, Math.min(1, gradient[name].y + delta[1])),
              });
            }}
            onKeyUp={finish}
          >
            {name === "start" ? "●" : "○"}
          </button>
        );
      })}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { ExportEnhanceSettings } from "../types";
import { geometry } from "./recipe";
import type { EditingBase } from "./renderer";

export function detailRegion(
  width: number,
  height: number,
  viewport: { width: number; height: number },
  center: { x: number; y: number },
) {
  const tw = Math.max(1, Math.min(width, 1536, Math.floor(viewport.width)));
  const th = Math.max(1, Math.min(height, 1536, Math.floor(viewport.height)));
  return {
    x: Math.max(0, Math.min(width - tw, Math.round(center.x * width - tw / 2))),
    y: Math.max(
      0,
      Math.min(height - th, Math.round(center.y * height - th / 2)),
    ),
    width: tw,
    height: th,
  };
}

export function DetailView({
  photoId,
  base,
  settings,
  original,
  clipping,
  initialCenter,
  onFit,
}: {
  photoId: string;
  base: EditingBase;
  settings: ExportEnhanceSettings;
  original: boolean;
  clipping: boolean;
  initialCenter: { x: number; y: number };
  onFit: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState({
    width: 1,
    height: 1,
    dpr: window.devicePixelRatio || 1,
  });
  const [center, setCenter] = useState(initialCenter);
  const [tile, setTile] = useState<{
    key: string;
    width: number;
    height: number;
    pixels: Float32Array;
  } | null>(null);
  const [error, setError] = useState("");
  const drag = useRef<{ x: number; y: number; center: typeof center } | null>(
    null,
  );
  const frame = geometry(
    base.sourceWidth ?? base.width,
    base.sourceHeight ?? base.height,
    settings.crop,
  );
  const region = detailRegion(frame.width, frame.height, viewport, center);
  const key = JSON.stringify({ photoId, settings, original, region });
  useEffect(() => {
    const measure = () => {
      const rect = host.current?.getBoundingClientRect();
      if (rect) {
        const dpr = window.devicePixelRatio || 1;
        setViewport({
          width: rect.width * dpr,
          height: rect.height * dpr,
          dpr,
        });
      }
    };
    const observer = new ResizeObserver(measure);
    if (host.current) observer.observe(host.current);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/photos/${encodeURIComponent(photoId)}/editing-detail`,
          {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings, region, original }),
          },
        );
        if (!response.ok)
          throw new Error(
            (await response.json()).error || "Unable to load detail",
          );
        const width = Number(response.headers.get("X-Image-Width")),
          height = Number(response.headers.get("X-Image-Height"));
        const pixels = new Float32Array(await response.arrayBuffer());
        if (!width || !height || pixels.length !== width * height * 3)
          throw new Error("Invalid detail tile");
        if (!controller.signal.aborted) setTile({ key, width, height, pixels });
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "Unable to load detail",
          );
      }
    }, 160);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key]);
  const ready = tile?.key === key;
  useEffect(() => {
    if (!ready || !tile || !canvas.current) return;
    const context = canvas.current.getContext("2d");
    if (!context) return;
    const out = context.createImageData(tile.width, tile.height);
    for (let i = 0; i < tile.width * tile.height; i++) {
      const r = tile.pixels[i * 3],
        g = tile.pixels[i * 3 + 1],
        b = tile.pixels[i * 3 + 2];
      const high = clipping && !original && Math.max(r, g, b) >= 0.999;
      const low = clipping && !original && !high && Math.min(r, g, b) <= 0.001;
      out.data[i * 4] = Math.round(
        Math.max(0, Math.min(1, high ? 1 : low ? 0.1 : r)) * 255,
      );
      out.data[i * 4 + 1] = Math.round(
        Math.max(0, Math.min(1, high ? 0.15 : low ? 0.35 : g)) * 255,
      );
      out.data[i * 4 + 2] = Math.round(
        Math.max(0, Math.min(1, high ? 0.12 : low ? 1 : b)) * 255,
      );
      out.data[i * 4 + 3] = 255;
    }
    context.putImageData(out, 0, 0);
  }, [tile, ready, clipping, original]);
  const pan = (dx: number, dy: number, before = center) => {
    const current = detailRegion(frame.width, frame.height, viewport, before);
    setCenter({
      x:
        Math.max(
          current.width / 2,
          Math.min(
            frame.width - current.width / 2,
            current.x + current.width / 2 + dx,
          ),
        ) / frame.width,
      y:
        Math.max(
          current.height / 2,
          Math.min(
            frame.height - current.height / 2,
            current.y + current.height / 2 + dy,
          ),
        ) / frame.height,
    });
  };
  return (
    <div
      ref={host}
      className="quick-detail"
      tabIndex={0}
      aria-label="100% native detail. Drag or use arrow keys to pan; double click to fit."
      onDoubleClick={onFit}
      onKeyDown={(event) => {
        const delta = {
          ArrowLeft: [-80, 0],
          ArrowRight: [80, 0],
          ArrowUp: [0, -80],
          ArrowDown: [0, 80],
        }[event.key];
        if (delta) {
          event.preventDefault();
          event.stopPropagation();
          pan(delta[0], delta[1]);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, center };
      }}
      onPointerMove={(event) => {
        if (drag.current)
          pan(
            (drag.current.x - event.clientX) * viewport.dpr,
            (drag.current.y - event.clientY) * viewport.dpr,
            drag.current.center,
          );
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    >
      {ready && tile ? (
        <canvas
          ref={canvas}
          width={tile.width}
          height={tile.height}
          style={{
            width: tile.width / viewport.dpr,
            height: tile.height / viewport.dpr,
          }}
          aria-label="Native resolution edited detail"
        />
      ) : null}
      <span className="quick-detail-status" role="status">
        {error ||
          (ready
            ? `${original ? "Original" : "Edited"} · 1 image pixel = 1 screen pixel · drag to pan`
            : "Loading native detail…")}
      </span>
    </div>
  );
}

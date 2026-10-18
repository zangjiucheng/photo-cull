import { useEffect, useRef, useState } from "react";
import type { ExportEnhanceSettings } from "../types";
import { EditingRenderer, type EditingBase } from "./renderer";

export function Histogram({
  base,
  settings,
}: {
  base: EditingBase | null;
  settings: ExportEnhanceSettings;
}) {
  const renderer = useRef<EditingRenderer | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    setPaths([]);
    setError(false);
    if (!base) return;
    const scale = Math.min(1, 256 / Math.max(base.width, base.height));
    const width = Math.max(1, Math.round(base.width * scale)),
      height = Math.max(1, Math.round(base.height * scale));
    const pixels = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const offset =
          (Math.min(base.height - 1, Math.floor(y / scale)) * base.width +
            Math.min(base.width - 1, Math.floor(x / scale))) *
          3;
        pixels.set(
          base.pixels.subarray(offset, offset + 3),
          (y * width + x) * 3,
        );
      }
    try {
      renderer.current = new EditingRenderer(document.createElement("canvas"), {
        width,
        height,
        pixels,
      });
    } catch {
      setError(true);
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [base]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (!renderer.current) return;
        renderer.current.draw(settings);
        const bins = renderer.current.histogram();
        const maximum = Math.max(1, ...bins.flat());
        setPaths(
          bins.map((channel) =>
            channel
              .map(
                (value, x) =>
                  `${x === 0 ? "M" : "L"}${x},${63 - Math.sqrt(value / maximum) * 60}`,
              )
              .join(" "),
          ),
        );
      } catch {
        setError(true);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [base, settings]);
  return (
    <figure
      className="quick-histogram"
      aria-label="Histogram of sampled edited crop in sRGB"
    >
      <svg
        viewBox="0 0 255 64"
        role="img"
        aria-label={
          error
            ? "Histogram unavailable"
            : "Red, green, blue and luminance distribution"
        }
      >
        {[64, 128, 192].map((x) => (
          <line key={x} x1={x} x2={x} y1="0" y2="64" stroke="#292929" />
        ))}
        {paths.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={["#dc7373", "#77b88c", "#7e9edb", "#ececec"][i]}
            strokeWidth="1"
            opacity=".8"
          />
        ))}
      </svg>
      <figcaption>
        {error ? "Histogram unavailable" : "Edited crop · sampled sRGB"}
      </figcaption>
    </figure>
  );
}

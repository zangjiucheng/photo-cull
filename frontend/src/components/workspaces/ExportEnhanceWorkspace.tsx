import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import type {
  ExportEnhanceJob,
  ExportEnhanceSettings,
  Photo,
  PhotoStylePreset,
  StylePad,
} from "../../types";
import { renderEditingPreview, type ExposureMatch } from "../../api";
import { CropOverlay, MAX_ANGLE, levelAngle, rotateCrop, viewCrop } from "../../editing/CropOverlay";
import { PresetManager } from "../../editing/PresetManager";
import { SnapshotList } from "../../editing/SnapshotList";
import { isMac, modPrefix, shiftModPrefix } from "../../lib/platform";
import {
  adjustmentGroups,
  applyAuto,
  applyPad,
  autoStrength,
  cloneSettings,
  defaultSettings,
  geometry,
  pasteSettings,
  presets,
  quickKeys,
  rebasePad,
  type AdjustmentGroup,
} from "../../editing/recipe";
import {
  EditingRenderer,
  loadEditingBase,
  type EditingBase,
} from "../../editing/renderer";
import { Button } from "../ui/button";
import { DetailView } from "../../editing/DetailView";
import { Histogram } from "../../editing/Histogram";
import { GradientOverlay, sourcePoint } from "../../editing/GradientOverlay";
import {
  hueOf,
  neutralWhiteBalance,
  sampleBase,
} from "../../editing/colorPicker";
import "./quick-editor.css";

interface ExportEnhanceWorkspaceProps {
  photos: Photo[];
  queuedIds: string[];
  selectedPhotoId: string | null;
  settings: ExportEnhanceSettings;
  outputFolder: string;
  job: ExportEnhanceJob | null;
  isStarting: boolean;
  isPreviewOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  saveState: "saved" | "saving" | "failed";
  saveError: string;
  onRetrySave: () => void;
  onSettingsChange: (settings: ExportEnhanceSettings) => void;
  onBeginAdjustment: () => void;
  onEndAdjustment: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onApplyToQueued: (
    settings: ExportEnhanceSettings,
    groups: AdjustmentGroup[],
  ) => void;
  onSelectPreviewPhoto: (id: string) => void;
  onChooseFolder: () => void;
  onOutputFolderChange: (path: string) => void;
  onPreviewOpenChange: (open: boolean) => void;
  onStart: () => void;
  onResume: (retryFailed: boolean) => void;
  onMatchExposure: () => Promise<{ scene: string; limitEv: number; results: ExposureMatch[] }>;
  onApplyExposureMatches: (exposures: Record<string, number>) => void;
  onCancel: () => void;
  onClearQueue: () => void;
}

type SliderKey =
  | (typeof quickKeys)[number]
  | "contrast"
  | "blackPoint"
  | "dehaze"
  | "saturation"
  | "tint"
  | "sharpen";
const labels: Record<SliderKey, string> = {
  exposure: "Exposure",
  brilliance: "Brilliance",
  highlights: "Highlights",
  shadows: "Shadows",
  vibrance: "Vibrance",
  temperature: "Warmth",
  contrast: "Contrast",
  blackPoint: "Black point",
  dehaze: "Dehaze",
  saturation: "Saturation",
  tint: "Tint",
  sharpen: "Definition",
};
const groupLabels: Record<AdjustmentGroup, string> = {
  local: "Local gradient",
  light: "Light",
  color: "Color",
  style: "Style",
  detail: "Detail",
  exposure: "Exposure",
  whiteBalance: "Warmth",
  crop: "Crop",
  output: "Export settings",
};
const thumbnailSettings = Object.fromEntries(
  Object.keys(presets).map((id) => [
    id,
    {
      ...defaultSettings,
      photoStyle: {
        preset: id as PhotoStylePreset,
        tone: 0,
        colour: 0,
        palette: 100,
      },
    },
  ]),
);

const presetGroups = Object.entries(presets).reduce<
  Array<{ group: string; ids: string[] }>
>((groups, [id, preset]) => {
  const last = groups[groups.length - 1];
  if (last?.group === preset.group) last.ids.push(id);
  else groups.push({ group: preset.group, ids: [id] });
  return groups;
}, []);

// Style thumbnails share one offscreen WebGL renderer that is released after drawing: one context
// per thumbnail would exceed the browser's ~16 live WebGL contexts and evict the main preview.
function StyleThumbnails({
  base,
  selected,
  onSelect,
}: {
  base: EditingBase | null;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  useEffect(() => {
    if (!base) return;
    const offscreen = document.createElement("canvas");
    let renderer: EditingRenderer | null = null;
    try {
      renderer = new EditingRenderer(offscreen, base);
      for (const [id, target] of canvases.current) {
        renderer.draw(thumbnailSettings[id]);
        target.width = offscreen.width;
        target.height = offscreen.height;
        target.getContext("2d")?.drawImage(offscreen, 0, 0);
      }
    } catch {
      // Thumbnails are a convenience; the placeholders stay if WebGL is unavailable.
    } finally {
      renderer?.dispose();
    }
  }, [base]);
  return (
    <div className="quick-styles">
      {presetGroups.map(({ group, ids }) => (
        <div className="quick-style-group" key={group}>
          <span className="quick-style-group-label">{group}</span>
          {ids.map((id) => (
            <button
              type="button"
              className={selected === id ? "active" : ""}
              aria-pressed={selected === id}
              key={id}
              onClick={() => onSelect(id)}
            >
              <canvas
                ref={(element) => {
                  if (element) canvases.current.set(id, element);
                  else canvases.current.delete(id);
                }}
              />
              <span>{presets[id as keyof typeof presets].label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// Apple-style Tone (vertical) / Color (horizontal) pad. It moves the sliders below rather than
// adding a hidden layer, so anything it does can be fine-tuned afterwards.
function TonePad({
  tone,
  colour,
  disabled,
  onBegin,
  onChange,
  onEnd,
}: {
  tone: number;
  colour: number;
  disabled: boolean;
  onBegin: () => void;
  onChange: (tone: number, colour: number) => void;
  onEnd: () => void;
}) {
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / rect.width),
    );
    const y = Math.max(
      0,
      Math.min(1, (event.clientY - rect.top) / rect.height),
    );
    onChange(1 - y * 2, x * 2 - 1);
  };
  return (
    <div
      className={`tone-pad${disabled ? " disabled" : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Tone and color"
      aria-disabled={disabled}
      aria-valuetext={`Tone ${Math.round(tone * 100)}, Color ${Math.round(colour * 100)}`}
      onPointerDown={(event) => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onBegin();
        move(event);
      }}
      onPointerMove={(event) => {
        if (!disabled && event.buttons === 1) move(event);
      }}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
      onDoubleClick={() => {
        if (disabled) return;
        onBegin();
        onChange(0, 0);
        onEnd();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const step = event.shiftKey ? 0.1 : 0.02;
        const moves: Record<string, [number, number]> = {
          ArrowUp: [step, 0],
          ArrowDown: [-step, 0],
          ArrowLeft: [0, -step],
          ArrowRight: [0, step],
        };
        const delta = moves[event.key];
        if (!delta) return;
        event.preventDefault();
        onBegin();
        onChange(tone + delta[0], colour + delta[1]);
        onEnd();
      }}
    >
      <span className="tone-pad-axis horizontal" />
      <span className="tone-pad-axis vertical" />
      <span
        className="tone-pad-dot"
        style={{ left: `${(colour + 1) * 50}%`, top: `${(1 - tone) * 50}%` }}
      />
      <em className="tone-pad-label top">More Tone</em>
      <em className="tone-pad-label bottom">Softer</em>
      <em className="tone-pad-label left">Muted</em>
      <em className="tone-pad-label right">Vivid</em>
    </div>
  );
}

function Slider({
  label,
  value,
  min = -1,
  max = 1,
  step = 0.01,
  onChange,
  onBegin,
  onEnd,
  reset = 0,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  reset?: number;
  onChange: (value: number) => void;
  onBegin: () => void;
  onEnd: () => void;
}) {
  return (
    <label className="quick-slider">
      <span>
        <span>{label}</span>
        <output>
          {label.toLowerCase().includes("exposure")
            ? `${value > 0 ? "+" : ""}${value.toFixed(2)} EV`
            : Math.round(value * 100)}
        </output>
      </span>
      <input
        aria-label={label}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          onBegin();
        }}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        onBlur={onEnd}
        onKeyDown={(event) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(event.key)
          )
            onBegin();
        }}
        onKeyUp={onEnd}
        onDoubleClick={() => onChange(reset)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function PreviewCanvas({
  base,
  settings,
  original = false,
  clipping = false,
  maskOverlay = false,
  onError,
  className = "",
}: {
  base: EditingBase;
  settings: ExportEnhanceSettings;
  original?: boolean;
  clipping?: boolean;
  maskOverlay?: boolean;
  onError?: (message: string) => void;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    renderer = useRef<EditingRenderer | null>(null);
  const [generation, setGeneration] = useState(0);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    try {
      renderer.current = new EditingRenderer(element, base);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Preview unavailable");
    }
    const lost = (event: Event) => {
      event.preventDefault();
      renderer.current = null;
      onError?.("Restoring live preview…");
    };
    const restored = () => {
      onError?.("");
      setGeneration((value) => value + 1);
    };
    element.addEventListener("webglcontextlost", lost);
    element.addEventListener("webglcontextrestored", restored);
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
      element.removeEventListener("webglcontextlost", lost);
      element.removeEventListener("webglcontextrestored", restored);
    };
  }, [base, generation, onError]);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        renderer.current?.draw(settings, original, clipping, maskOverlay);
      } catch (error) {
        onError?.(
          error instanceof Error ? error.message : "Preview unavailable",
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [base, settings, original, clipping, maskOverlay, generation, onError]);
  return (
    <canvas
      ref={canvas}
      className={className}
      aria-label="Edited photo preview"
    />
  );
}

function NeutralCanvas({
  base,
  crop,
}: {
  base: EditingBase;
  crop: ExportEnhanceSettings["crop"];
}) {
  const output = useRef<HTMLCanvasElement>(null);
  const source = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = base.width;
    canvas.height = base.height;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(base.width, base.height);
    for (let i = 0; i < base.width * base.height; i++) {
      for (let c = 0; c < 3; c++)
        image.data[i * 4 + c] = Math.round(base.pixels[i * 3 + c] * 255);
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }, [base]);
  useLayoutEffect(() => {
    const canvas = output.current;
    if (!canvas) return;
    const g = geometry(base.width, base.height, crop);
    canvas.width = g.width;
    canvas.height = g.height;
    const context = canvas.getContext("2d")!;
    context.setTransform(
      g.c,
      -g.s,
      g.s,
      g.c,
      g.width / 2 - g.c * g.cx - g.s * g.cy,
      g.height / 2 + g.s * g.cx - g.c * g.cy,
    );
    context.drawImage(source, 0, 0);
  }, [source, base, crop]);
  return <canvas ref={output} aria-label="Original RAW development" />;
}

export function ExportEnhanceWorkspace(props: ExportEnhanceWorkspaceProps) {
  const {
    photos,
    queuedIds,
    selectedPhotoId,
    settings,
    onSettingsChange,
    onBeginAdjustment,
    onEndAdjustment,
  } = props;
  const queued = queuedIds
    .map((id) => photos.find((photo) => photo.id === id))
    .filter((p): p is Photo => !!p);
  const photo =
    queued.find((p) => p.id === selectedPhotoId) ?? queued[0] ?? null;
  const photoKey = photo
    ? `${photo.id}:${photo.mtime}:${photo.orientationOverride}`
    : "";
  const [baseState, setBaseState] = useState<{
    key: string;
    base: EditingBase;
  } | null>(null);
  const base = baseState?.key === photoKey ? baseState.base : null;
  const thumbnailBase = useMemo(() => {
    if (!base) return null;
    const scale = Math.min(1, 160 / Math.max(base.width, base.height));
    const width = Math.max(1, Math.round(base.width * scale)),
      height = Math.max(1, Math.round(base.height * scale));
    const pixels = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const source =
          (Math.min(base.height - 1, Math.floor(y / scale)) * base.width +
            Math.min(base.width - 1, Math.floor(x / scale))) *
          3;
        pixels.set(
          base.pixels.subarray(source, source + 3),
          (y * width + x) * 3,
        );
      }
    return { width, height, pixels };
  }, [base]);
  const [baseError, setBaseError] = useState("");
  const [gpuError, setGpuError] = useState("");
  const [original, setOriginal] = useState(false),
    [clipping, setClipping] = useState(false),
    [grid, setGrid] = useState(false),
    [leveling, setLeveling] = useState(false),
    [exposurePlan, setExposurePlan] = useState<ExposureMatch[] | null>(null),
    [matching, setMatching] = useState(false);
  const [backendState, setBackendState] = useState<{
      key: string;
      url: string;
    } | null>(null),
    [rendering, setRendering] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [denoiseEngine, setDenoiseEngine] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [padVectors, setPadVectors] = useState<{
    key: string;
    vectors: StylePad["vectors"];
  } | null>(null);
  const currentPhoto = useRef(photoKey);
  currentPhoto.current = photoKey;
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const [copy, setCopy] = useState<ExportEnhanceSettings | null>(null);
  const [groups, setGroups] = useState<AdjustmentGroup[]>([
    "light",
    "color",
    "style",
    "detail",
  ]);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState(false);
  const [gradientHandles, setGradientHandles] = useState(false);
  const [gradientMask, setGradientMask] = useState(false);
  const [picker, setPicker] = useState<"color" | "whiteBalance" | null>(null);
  const [detailCenter, setDetailCenter] = useState({ x: 0.5, y: 0.5 });
  const detailAvailable =
    !!base &&
    settings.recipeVersion === 2 &&
    !settings.aiDenoise &&
    !settings.upscale;
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 1, height: 1 });
  const onGpuError = useCallback((message: string) => setGpuError(message), []);
  const legacy = settings.recipeVersion === 1;
  const backendNeeded =
    legacy || settings.aiDenoise || settings.upscale || !!gpuError;
  const renderKey = `${photoKey}:${JSON.stringify(settings)}`;
  const backendPreview =
    backendState?.key === renderKey ? backendState.url : null;
  const running =
    props.job?.status === "queued" || props.job?.status === "running";
  const index = photo ? queued.findIndex((p) => p.id === photo.id) : -1;
  const progress = props.job?.total
    ? Math.round(
        ((props.job.completed + props.job.failed) / props.job.total) * 100,
      )
    : 0;
  // While the crop section is open the preview shows the whole image at the crop's angle, with
  // the crop drawn on top (like Lightroom/Photos), instead of the cropped result.
  const cropping = grid && !!base && !legacy;
  const shownCrop = cropping ? viewCrop(settings.crop) : settings.crop;
  const shownSettings = cropping ? { ...settings, crop: shownCrop } : settings;
  const frame = base
    ? geometry(base.width, base.height, shownCrop)
    : { width: 4, height: 3 };
  const frameScale = Math.min(
    area.width / frame.width,
    area.height / frame.height,
  );

  useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setArea({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [photo?.id]);

  useEffect(() => {
    // Keep the current frame visible in the filmstrip.
    areaRef.current?.parentElement
      ?.querySelector(".quick-filmstrip .active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [photo?.id]);

  useEffect(() => {
    if (!photo) return;
    const controller = new AbortController();
    setBaseError("");
    setGpuError("");
    setOriginal(false);
    setAutoBusy(false);
    setDetail(false);
    setGradientHandles(false);
    setGradientMask(false);
    setPicker(null);
    setDetailCenter({ x: 0.5, y: 0.5 });
    loadEditingBase(photo.id, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setBaseState({ key: photoKey, base: value });
        // Develop the neighbours in the background so stepping through the filmstrip is instant.
        const index = queued.findIndex((p) => p.id === photo.id);
        for (const neighbour of [queued[index + 1], queued[index - 1]])
          if (neighbour)
            void fetch(
              `/api/photos/${encodeURIComponent(neighbour.id)}/prefetch`,
              { method: "POST" },
            ).catch(() => undefined);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setBaseError(error.message);
      });
    setPadVectors(null);
    fetch(`/api/photos/${encodeURIComponent(photo.id)}/style-pad`, {
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (!controller.signal.aborted && value)
          setPadVectors({
            key: photoKey,
            vectors: value as StylePad["vectors"],
          });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [photoKey]); // Source edits and orientation invalidate the editing base.

  useEffect(() => {
    if (!photo || !backendNeeded) {
      setBackendState(null);
      setRendering(false);
      return;
    }
    const controller = new AbortController();
    let url: string | null = null;
    setBackendState(null);
    setRendering(true);
    setPreviewError("");
    const timer = window.setTimeout(() => {
      renderEditingPreview(photo.id, settings, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          url = URL.createObjectURL(result.blob);
          setBackendState({ key: renderKey, url });
          setDenoiseEngine(result.denoiseEngine);
          setRendering(false);
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setPreviewError(error.message);
            setRendering(false);
          }
        });
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [photoKey, settings, backendNeeded, renderKey]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input,textarea,select") || target.isContentEditable)
        return;
      if (event.key === "\\") {
        event.preventDefault();
        setOriginal(true);
      }
      // Ctrl+Y is the usual redo on Windows and Linux.
      if (!isMac && event.ctrlKey && event.key.toLowerCase() === "y") {
        event.preventDefault();
        event.stopImmediatePropagation();
        props.onRedo();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) props.onRedo();
        else props.onUndo();
      }
      if (event.key === "Escape") {
        setPicker(null);
        props.onPreviewOpenChange(false);
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key === "\\") setOriginal(false);
    };
    const blur = () => setOriginal(false);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    };
  });

  const update = (key: SliderKey, value: number) =>
    onSettingsChange(rebasePad({ ...settings, [key]: value, auto: null }));
  const slider = (key: SliderKey) => (
    <Slider
      key={key}
      label={labels[key]}
      value={settings[key]}
      min={key === "sharpen" ? 0 : key === "exposure" ? -3 : -1}
      max={key === "exposure" ? 3 : 1}
      onBegin={onBeginAdjustment}
      onEnd={onEndAdjustment}
      onChange={(value) => update(key, value)}
    />
  );
  const updateCrop = (crop: ExportEnhanceSettings["crop"]) =>
    onSettingsChange({ ...settings, crop });
  const fitRatio = (ratio: number) => {
    if (!base) return;
    const aspect = base.width / base.height;
    const width = Math.min(1, ratio / aspect),
      height = Math.min(1, aspect / ratio);
    updateCrop({
      x: (1 - width) / 2,
      y: (1 - height) / 2,
      width,
      height,
      angle: settings.crop.angle,
    });
    setGrid(true);
  };
  const auto = async () => {
    if (!photo || autoBusy) return;
    const key = photoKey,
      before = cloneSettings(settings);
    setAutoBusy(true);
    setNotice("");
    try {
      const response = await fetch(
        `/api/photos/${encodeURIComponent(photo.id)}/auto-adjustments`,
      );
      if (!response.ok) throw new Error("Unable to analyze this photo");
      const suggestions = (await response.json()) as Record<string, number>;
      if (
        currentPhoto.current !== key ||
        JSON.stringify(latestSettings.current) !== JSON.stringify(before)
      )
        return;
      onSettingsChange(applyAuto(before, suggestions));
    } catch (error) {
      if (currentPhoto.current === key)
        setNotice(
          error instanceof Error ? error.message : "Auto enhance failed",
        );
    } finally {
      if (currentPhoto.current === key) setAutoBusy(false);
    }
  };
  const preview = photo ? (
    <div
      className={`quick-image ${grid ? "show-grid" : ""} ${picker ? "quick-picking" : ""}`}
      title={
        picker
          ? "Click a color in the photo"
          : "Double click for native 100% detail"
      }
      onClick={(event) => {
        if (!picker || !base) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const point = sourcePoint(
          base.width,
          base.height,
          shownCrop,
          (event.clientX - rect.left) / rect.width,
          (event.clientY - rect.top) / rect.height,
        );
        const rgb = sampleBase(base, point);
        try {
          if (picker === "whiteBalance") {
            const { temperature, tint, limited } = neutralWhiteBalance(rgb);
            onSettingsChange({ ...settings, temperature, tint, auto: null });
            setNotice(
              limited
                ? "White balance reached the slider limit. Choose a neutral gray surface."
                : "Neutral white balance applied before style and local adjustments.",
            );
          } else {
            const renderer = new EditingRenderer(
              document.createElement("canvas"),
              { width: 1, height: 1, pixels: new Float32Array(rgb) },
            );
            try {
              renderer.draw({
                ...settings,
                crop: defaultSettings.crop,
                gradient: null,
                selectedColor: null,
                sharpen: 0,
              });
              const center = hueOf(renderer.readPixel());
              onSettingsChange({
                ...settings,
                selectedColor: {
                  range: 0.12,
                  hue: 0,
                  saturation: 0,
                  luminance: 0,
                  ...settings.selectedColor,
                  center,
                },
              });
            } finally {
              renderer.dispose();
            }
            setNotice(
              "Color selected. Adjust hue, saturation or luminance below.",
            );
          }
          setPicker(null);
        } catch (error) {
          setNotice(
            error instanceof Error
              ? error.message
              : "Unable to sample this color",
          );
        }
      }}
      onDoubleClick={(event) => {
        if (!detailAvailable || picker) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setDetailCenter({
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
        });
        setDetail(true);
      }}
      style={{
        width: Math.max(1, frame.width * frameScale),
        height: Math.max(1, frame.height * frameScale),
      }}
    >
      {base && !legacy ? (
        <PreviewCanvas
          base={base}
          settings={shownSettings}
          original={original}
          clipping={clipping}
          maskOverlay={gradientMask}
          onError={onGpuError}
        />
      ) : null}
      {backendPreview && !original && !cropping ? (
        <img
          className="quick-rendered"
          src={backendPreview}
          alt={`${photo.name} edited`}
        />
      ) : null}
      {base && gpuError && !legacy && (!backendPreview || original) ? (
        <NeutralCanvas base={base} crop={shownCrop} />
      ) : null}
      {(!base || legacy) && (!backendPreview || original) ? (
        <img src={photo.url} alt={photo.name} />
      ) : null}
      {cropping && base && !original ? (
        <CropOverlay
          base={base}
          crop={settings.crop}
          leveling={leveling}
          onChange={updateCrop}
          onBegin={onBeginAdjustment}
          onEnd={onEndAdjustment}
          onLevel={(points) => {
            setLeveling(false);
            if (!points) {
              setNotice("Click two points farther apart along the horizon.");
              return;
            }
            const angle = levelAngle(base.width, base.height, points[0], points[1]);
            if (Math.abs(angle) > MAX_ANGLE) {
              setNotice(`That line is tilted ${angle.toFixed(1)}°; straightening is limited to ±${MAX_ANGLE}°.`);
              return;
            }
            updateCrop(rotateCrop(base.width, base.height, settings.crop, angle));
            setNotice(`Leveled to ${angle.toFixed(1)}°.`);
          }}
        />
      ) : grid ? (
        <div className="quick-grid" aria-hidden="true">
          <i />
          <i />
          <b />
          <b />
        </div>
      ) : null}
      {base && settings.gradient?.enabled && gradientHandles && !original && !cropping ? (
        <GradientOverlay
          base={base}
          crop={settings.crop}
          gradient={settings.gradient}
          onChange={(gradient) => onSettingsChange({ ...settings, gradient })}
          onBegin={onBeginAdjustment}
          onEnd={onEndAdjustment}
        />
      ) : null}
    </div>
  ) : null;

  return (
    <div className={`quick-editor ${props.isPreviewOpen ? "expanded" : ""}`}>
      <header className="quick-toolbar">
        <div className="quick-toolbar-title">
          <strong>{photo?.name ?? "Edit photos"}</strong>
          <span>
            {queued.length
              ? `${index + 1} of ${queued.length}`
              : "Add photos from Browse or Review"}
          </span>
        </div>
        <div className="quick-toolbar-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onUndo}
            disabled={!props.canUndo}
          >
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onRedo}
            disabled={!props.canRedo}
          >
            Redo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onReset}
            disabled={!photo}
          >
            Reset
          </Button>
          <span className="quick-toolbar-sep" aria-hidden="true" />
          <Button variant="ghost" size="sm" onClick={props.onChooseFolder}>
            Folder…
          </Button>
          <Button
            size="sm"
            onClick={props.onStart}
            disabled={
              !queued.length ||
              !props.outputFolder ||
              running ||
              props.isStarting
            }
          >
            {running ? "Exporting…" : `Export ${queued.length || "photos"}`}
          </Button>
        </div>
      </header>
      <div className="quick-body">
        <section className="quick-stage" aria-label="Photo editing canvas">
          {photo ? (
            <>
              <div className="quick-image-area" ref={areaRef}>
                {detail && detailAvailable && base ? (
                  <DetailView
                    key={photoKey}
                    photoId={photo.id}
                    base={base}
                    settings={settings}
                    original={original}
                    clipping={clipping}
                    initialCenter={detailCenter}
                    onFit={() => setDetail(false)}
                  />
                ) : (
                  preview
                )}
              </div>
              <div className="quick-stage-tools">
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  aria-pressed={detail && detailAvailable}
                  disabled={!detailAvailable}
                  title={
                    detailAvailable
                      ? "Native detail before output resize. Double click the photo to inspect a point."
                      : "Turn off noise reduction and upscale to inspect native color detail"
                  }
                  onClick={() => setDetail(!detail)}
                >
                  {detail && detailAvailable ? "Fit" : "100%"}
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setOriginal(true);
                  }}
                  onPointerUp={() => setOriginal(false)}
                  onPointerCancel={() => setOriginal(false)}
                  onBlur={() => setOriginal(false)}
                  onKeyDown={(event) => {
                    if (event.key === " " || event.key === "Enter") {
                      event.preventDefault();
                      setOriginal(true);
                    }
                  }}
                  onKeyUp={() => setOriginal(false)}
                  aria-pressed={original}
                >
                  Hold for original <kbd>\</kbd>
                </button>
                <span role="status">
                  {baseError ||
                    previewError ||
                    (rendering
                      ? "Updating preview…"
                      : base
                        ? original
                          ? "Original"
                          : "Edited"
                        : "Developing RAW…")}
                </span>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  onClick={() =>
                    props.onPreviewOpenChange(!props.isPreviewOpen)
                  }
                >
                  {props.isPreviewOpen ? "Close full screen" : "Full screen"}
                </button>
              </div>
              <div className="quick-filmstrip" aria-label="Queued photos">
                {queued.map((item, i) => (
                  <button
                    type="button"
                    aria-current={item.id === photo.id ? "true" : undefined}
                    className={item.id === photo.id ? "active" : ""}
                    key={item.id}
                    title={item.name}
                    onClick={() => props.onSelectPreviewPhoto(item.id)}
                  >
                    <img src={item.url} alt={item.name} loading="lazy" />
                    <span>{i + 1}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="quick-empty">
              <strong>Your finishing room</strong>
              <p>
                Queue your picks from Browse or Review, then adjust and export
                them here.
              </p>
            </div>
          )}
        </section>
        <aside className="quick-adjustments" aria-label="Photo adjustments">
          <fieldset disabled={!photo}>
            {!legacy ? <Histogram base={base} settings={settings} /> : null}
            {legacy ? (
              <div className="quick-legacy">
                <strong>Legacy edit preserved</strong>
                <p>
                  This photo uses the previous color engine. Switch to the new
                  controls to start a neutral edit. Undo restores this recipe.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onSettingsChange(cloneSettings(defaultSettings))
                  }
                >
                  Use new controls
                </Button>
              </div>
            ) : (
              <>
                <section className="quick-section">
                  <div className="quick-section-title">
                    <h2>Adjust</h2>
                    <Button
                      variant="outline"
                      size="sm"
                      className="quick-auto"
                      disabled={autoBusy || !base}
                      onClick={() => void auto()}
                    >
                      {autoBusy ? "Analyzing…" : "✧ Auto"}
                    </Button>
                  </div>
                  {settings.auto ? (
                    <Slider
                      label="Auto strength"
                      value={settings.auto.strength}
                      min={0}
                      onBegin={onBeginAdjustment}
                      onEnd={onEndAdjustment}
                      onChange={(value) =>
                        onSettingsChange(
                          rebasePad(autoStrength(settings, value)),
                        )
                      }
                    />
                  ) : null}
                  <TonePad
                    tone={settings.pad?.tone ?? 0}
                    colour={settings.pad?.colour ?? 0}
                    disabled={!settings.pad && padVectors?.key !== photoKey}
                    onBegin={onBeginAdjustment}
                    onEnd={onEndAdjustment}
                    onChange={(tone, colour) =>
                      onSettingsChange(
                        applyPad(
                          settings,
                          tone,
                          colour,
                          padVectors?.key === photoKey
                            ? padVectors.vectors
                            : undefined,
                        ),
                      )
                    }
                  />
                  {quickKeys.map(slider)}
                  <small className="quick-hint">
                    Drag the pad, then fine-tune any slider. Double-click to
                    reset.
                  </small>
                </section>
                <details className="quick-section" open>
                  <summary>Styles</summary>
                  <StyleThumbnails
                    base={thumbnailBase}
                    selected={settings.photoStyle.preset}
                    onSelect={(id) =>
                      onSettingsChange({
                        ...settings,
                        photoStyle: {
                          preset: id as PhotoStylePreset,
                          tone: 0,
                          colour: 0,
                          palette: settings.photoStyle.palette,
                        },
                      })
                    }
                  />
                  <Slider
                    label="Style strength"
                    value={settings.photoStyle.palette / 100}
                    min={0}
                    onBegin={onBeginAdjustment}
                    onEnd={onEndAdjustment}
                    onChange={(value) =>
                      onSettingsChange({
                        ...settings,
                        photoStyle: {
                          ...settings.photoStyle,
                          palette: Math.round(value * 100),
                        },
                      })
                    }
                  />
                </details>
                <details className="quick-section">
                  <summary>Light & color</summary>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!base}
                    onClick={() => {
                      setPicker(
                        picker === "whiteBalance" ? null : "whiteBalance",
                      );
                      setDetail(false);
                      setGradientHandles(false);
                    }}
                  >
                    {picker === "whiteBalance"
                      ? "Cancel neutral picker"
                      : "Pick neutral gray"}
                  </Button>
                  {(
                    [
                      "contrast",
                      "blackPoint",
                      "dehaze",
                      "saturation",
                      "tint",
                      "sharpen",
                    ] as SliderKey[]
                  ).map(slider)}
                  <label className="quick-check">
                    <input
                      type="checkbox"
                      checked={clipping}
                      onChange={(event) => setClipping(event.target.checked)}
                    />{" "}
                    Show clipping (red / blue)
                  </label>
                </details>
                <details className="quick-section">
                  <summary>Selective color</summary>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!base || backendNeeded}
                    onClick={() => {
                      setPicker(picker === "color" ? null : "color");
                      setDetail(false);
                      setGradientHandles(false);
                    }}
                  >
                    {picker === "color"
                      ? "Cancel color picker"
                      : "Pick color from photo"}
                  </Button>
                  <div className="quick-color-swatches" aria-label="Color band">
                    {(
                      [
                        "Red",
                        "Yellow",
                        "Green",
                        "Cyan",
                        "Blue",
                        "Purple",
                      ] as const
                    ).map((name, i) => (
                      <button
                        type="button"
                        key={name}
                        aria-label={`Select ${name.toLowerCase()} colors`}
                        title={name}
                        style={{ background: `hsl(${i * 60} 60% 55%)` }}
                        onClick={() =>
                          onSettingsChange({
                            ...settings,
                            selectedColor: {
                              range: 0.12,
                              hue: 0,
                              saturation: 0,
                              luminance: 0,
                              ...settings.selectedColor,
                              center: i / 6,
                            },
                          })
                        }
                      />
                    ))}
                  </div>
                  {settings.selectedColor ? (
                    <>
                      <p className="quick-hint">
                        Selected hue:{" "}
                        {Math.round(settings.selectedColor.center * 360)}°
                      </p>
                      {(
                        ["hue", "saturation", "luminance", "range"] as const
                      ).map((key) => (
                        <Slider
                          key={key}
                          label={
                            {
                              hue: "Selected hue",
                              saturation: "Selected saturation",
                              luminance: "Selected luminance",
                              range: "Color range",
                            }[key]
                          }
                          value={settings.selectedColor![key]}
                          min={key === "range" ? 0.02 : -1}
                          max={key === "range" ? 0.5 : 1}
                          reset={key === "range" ? 0.12 : 0}
                          onBegin={onBeginAdjustment}
                          onEnd={onEndAdjustment}
                          onChange={(value) =>
                            onSettingsChange({
                              ...settings,
                              selectedColor: {
                                ...settings.selectedColor!,
                                [key]: value,
                              },
                            })
                          }
                        />
                      ))}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          onSettingsChange({ ...settings, selectedColor: null })
                        }
                      >
                        Reset selected color
                      </Button>
                    </>
                  ) : null}
                  <p className="quick-hint">
                    Changes every matching color, including sky and water.
                    Low-chroma grays are protected.
                  </p>
                </details>
                <details className="quick-section">
                  <summary>Local gradient</summary>
                  {settings.gradient ? (
                    <>
                      <div className="quick-local-actions">
                        <label className="quick-check">
                          <input
                            type="checkbox"
                            checked={settings.gradient.enabled}
                            onChange={(event) =>
                              onSettingsChange({
                                ...settings,
                                gradient: {
                                  ...settings.gradient!,
                                  enabled: event.target.checked,
                                },
                              })
                            }
                          />{" "}
                          Enabled
                        </label>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          onClick={() =>
                            onSettingsChange({ ...settings, gradient: null })
                          }
                        >
                          Delete
                        </button>
                      </div>
                      <label className="quick-check">
                        <input
                          type="checkbox"
                          checked={gradientHandles}
                          onChange={(event) => {
                            setGradientHandles(event.target.checked);
                            setDetail(false);
                          }}
                        />{" "}
                        Show handles
                      </label>
                      <label className="quick-check">
                        <input
                          type="checkbox"
                          checked={gradientMask}
                          disabled={backendNeeded}
                          onChange={(event) => {
                            setGradientMask(event.target.checked);
                            setDetail(false);
                          }}
                        />{" "}
                        Show affected area
                      </label>
                      <label className="quick-check">
                        <input
                          type="checkbox"
                          checked={settings.gradient.invert}
                          onChange={(event) =>
                            onSettingsChange({
                              ...settings,
                              gradient: {
                                ...settings.gradient!,
                                invert: event.target.checked,
                              },
                            })
                          }
                        />{" "}
                        Invert
                      </label>
                      {(
                        [
                          "exposure",
                          "highlights",
                          "temperature",
                          "feather",
                        ] as const
                      ).map((key) => (
                        <Slider
                          key={key}
                          label={
                            {
                              exposure: "Local exposure",
                              highlights: "Local highlights",
                              temperature: "Local warmth",
                              feather: "Feather",
                            }[key]
                          }
                          value={settings.gradient![key]}
                          min={
                            key === "feather"
                              ? 0.05
                              : key === "exposure"
                                ? -2
                                : -1
                          }
                          max={key === "exposure" ? 2 : 1}
                          reset={key === "feather" ? 1 : 0}
                          onBegin={onBeginAdjustment}
                          onEnd={onEndAdjustment}
                          onChange={(value) =>
                            onSettingsChange({
                              ...settings,
                              gradient: { ...settings.gradient!, [key]: value },
                            })
                          }
                        />
                      ))}
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm"
                        disabled={!base}
                        onClick={() => {
                          if (!base) return;
                          onSettingsChange({
                            ...settings,
                            gradient: {
                              ...settings.gradient!,
                              start: sourcePoint(
                                base.width,
                                base.height,
                                settings.crop,
                                0.5,
                                0.2,
                              ),
                              end: sourcePoint(
                                base.width,
                                base.height,
                                settings.crop,
                                0.5,
                                0.7,
                              ),
                            },
                          });
                          setGradientHandles(true);
                          setDetail(false);
                        }}
                      >
                        Center handles in crop
                      </button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!base}
                      onClick={() => {
                        if (!base) return;
                        onSettingsChange({
                          ...settings,
                          gradient: {
                            start: sourcePoint(
                              base.width,
                              base.height,
                              settings.crop,
                              0.5,
                              0.2,
                            ),
                            end: sourcePoint(
                              base.width,
                              base.height,
                              settings.crop,
                              0.5,
                              0.7,
                            ),
                            enabled: true,
                            invert: false,
                            feather: 1,
                            exposure: -0.3,
                            highlights: 0,
                            temperature: 0,
                          },
                        });
                        setGradientHandles(true);
                        setDetail(false);
                      }}
                    >
                      Add gradient
                    </Button>
                  )}
                  <p className="quick-hint">
                    Drag the filled and open points to set the transition. A
                    gradient affects everything across that area.
                  </p>
                </details>
                <details
                  className="quick-section"
                  onToggle={(event) => {
                    setGrid(event.currentTarget.open);
                    if (!event.currentTarget.open) setLeveling(false);
                  }}
                >
                  <summary>Crop & straighten</summary>
                  <div className="quick-ratios">
                    {[
                      ["Original", base ? base.width / base.height : 4 / 3],
                      ["1:1", 1],
                      ["4:3", 4 / 3],
                      ["3:2", 3 / 2],
                      ["16:9", 16 / 9],
                      ["9:16", 9 / 16],
                    ].map(([name, ratio]) => (
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary ui-btn-sm"
                        key={name}
                        onClick={() => fitRatio(Number(ratio))}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <Slider
                    label="Straighten"
                    value={settings.crop.angle / 15}
                    onBegin={onBeginAdjustment}
                    onEnd={onEndAdjustment}
                    onChange={(value) =>
                      updateCrop(
                        base
                          ? rotateCrop(base.width, base.height, settings.crop, value * 15)
                          : { ...settings.crop, angle: value * 15 },
                      )
                    }
                  />
                  <div className="quick-button-row">
                    <button
                      type="button"
                      className={`ui-btn ui-btn-sm ${leveling ? "ui-btn-default" : "ui-btn-secondary"}`}
                      aria-pressed={leveling}
                      onClick={() => setLeveling(!leveling)}
                    >
                      {leveling ? "Click two points on the horizon…" : "Level horizon"}
                    </button>
                  </div>
                  <span className="quick-hint">
                    {settings.crop.angle.toFixed(1)}° · drag the frame or its
                    edges on the photo; Shift keeps the shape
                  </span>
                  <Slider
                    label="Crop size"
                    value={Math.max(settings.crop.width, settings.crop.height)}
                    min={0.1}
                    reset={1}
                    onBegin={onBeginAdjustment}
                    onEnd={onEndAdjustment}
                    onChange={(value) => {
                      const factor =
                          value /
                          Math.max(settings.crop.width, settings.crop.height),
                        width = settings.crop.width * factor,
                        height = settings.crop.height * factor;
                      updateCrop({
                        ...settings.crop,
                        width,
                        height,
                        x: Math.min(
                          1 - width,
                          Math.max(
                            0,
                            settings.crop.x + (settings.crop.width - width) / 2,
                          ),
                        ),
                        y: Math.min(
                          1 - height,
                          Math.max(
                            0,
                            settings.crop.y +
                              (settings.crop.height - height) / 2,
                          ),
                        ),
                      });
                    }}
                  />
                  <Slider
                    label="Horizontal position"
                    value={
                      settings.crop.width < 1
                        ? settings.crop.x / (1 - settings.crop.width)
                        : 0.5
                    }
                    min={0}
                    reset={0.5}
                    onBegin={onBeginAdjustment}
                    onEnd={onEndAdjustment}
                    onChange={(value) =>
                      updateCrop({
                        ...settings.crop,
                        x: value * (1 - settings.crop.width),
                      })
                    }
                  />
                  <Slider
                    label="Vertical position"
                    value={
                      settings.crop.height < 1
                        ? settings.crop.y / (1 - settings.crop.height)
                        : 0.5
                    }
                    min={0}
                    reset={0.5}
                    onBegin={onBeginAdjustment}
                    onEnd={onEndAdjustment}
                    onChange={(value) =>
                      updateCrop({
                        ...settings.crop,
                        y: value * (1 - settings.crop.height),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    onClick={() => updateCrop({ ...defaultSettings.crop })}
                  >
                    Reset crop
                  </button>
                </details>
                <details className="quick-section">
                  <summary>Copy adjustments & presets</summary>
                  <div className="quick-copy-groups">
                    {(Object.keys(adjustmentGroups) as AdjustmentGroup[]).map(
                      (group) => (
                        <label key={group}>
                          <input
                            type="checkbox"
                            checked={groups.includes(group)}
                            onChange={(event) =>
                              setGroups(
                                event.target.checked
                                  ? [...groups, group]
                                  : groups.filter((g) => g !== group),
                              )
                            }
                          />
                          {groupLabels[group]}
                        </label>
                      ),
                    )}
                  </div>
                  <div className="quick-button-row">
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary ui-btn-sm"
                      onClick={() => {
                        setCopy(cloneSettings(settings));
                        setNotice("Adjustments copied");
                      }}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary ui-btn-sm"
                      disabled={!copy || !groups.length}
                      onClick={() =>
                        copy &&
                        onSettingsChange(pasteSettings(settings, copy, groups))
                      }
                    >
                      Paste
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary ui-btn-sm"
                      disabled={queued.length < 2 || !groups.length}
                      onClick={() => props.onApplyToQueued(settings, groups)}
                    >
                      Apply to queue
                    </button>
                  </div>
                  <div className="quick-button-row">
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary ui-btn-sm"
                      disabled={queued.length < 2 || matching || legacy}
                      title="Bring the other queued photos to this photo's brightness. Only exposure changes."
                      onClick={() => {
                        setMatching(true);
                        setExposurePlan(null);
                        props
                          .onMatchExposure()
                          .then((plan) => setExposurePlan(plan.results))
                          .catch((error) =>
                            setNotice(error instanceof Error ? error.message : "Unable to match exposure"),
                          )
                          .finally(() => setMatching(false));
                      }}
                    >
                      {matching ? "Measuring…" : "Match exposure to this photo"}
                    </button>
                  </div>
                  {exposurePlan ? (
                    <div className="exposure-plan" role="region" aria-label="Exposure match preview">
                      {exposurePlan.map((row) => (
                        <div key={row.photoId} className={`exposure-plan-row ${row.status}`}>
                          <span>{row.name}</span>
                          <span>
                            {row.status === "adjust"
                              ? `${(row.deltaEv ?? 0) > 0 ? "+" : ""}${(row.deltaEv ?? 0).toFixed(2)} EV${row.limited ? " (capped)" : ""}`
                              : row.status === "unchanged"
                                ? "matches"
                                : "skipped"}
                          </span>
                          {row.reason ? <small>{row.reason}</small> : null}
                        </div>
                      ))}
                      <div className="quick-button-row">
                        <button
                          type="button"
                          className="ui-btn ui-btn-default ui-btn-sm"
                          disabled={!exposurePlan.some((row) => row.status === "adjust")}
                          onClick={() => {
                            props.onApplyExposureMatches(
                              Object.fromEntries(
                                exposurePlan
                                  .filter((row) => row.status === "adjust" && row.proposed !== undefined)
                                  .map((row) => [row.photoId, row.proposed as number]),
                              ),
                            );
                            setExposurePlan(null);
                          }}
                        >
                          Apply {exposurePlan.filter((row) => row.status === "adjust").length}
                        </button>
                        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setExposurePlan(null)}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <PresetManager
                    settings={settings}
                    onApply={(preset) =>
                      onSettingsChange(pasteSettings(settings, preset, groups))
                    }
                    onNotice={setNotice}
                  />
                  <small className="quick-hint">
                    Presets apply the groups selected above and are kept in
                    the library, so backups include them.
                  </small>
                </details>
                <details className="quick-section">
                  <summary>Versions</summary>
                  <SnapshotList
                    photoId={photo.id}
                    settings={settings}
                    onRestore={onSettingsChange}
                    onNotice={setNotice}
                  />
                </details>
                <details className="quick-section">
                  <summary>Noise reduction & upscale</summary>
                  <label className="quick-check">
                    <input
                      type="checkbox"
                      checked={settings.aiDenoise}
                      onChange={(event) =>
                        onSettingsChange({
                          ...settings,
                          aiDenoise: event.target.checked,
                        })
                      }
                    />{" "}
                    Noise reduction
                  </label>
                  <select
                    className="ui-select"
                    aria-label="Noise reduction strength"
                    value={settings.aiDenoiseStrength}
                    disabled={!settings.aiDenoise}
                    onChange={(event) =>
                      onSettingsChange({
                        ...settings,
                        aiDenoiseStrength: event.target
                          .value as ExportEnhanceSettings["aiDenoiseStrength"],
                      })
                    }
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                  <small className="quick-hint">
                    Traditional noise reduction: OpenCV non-local means when
                    available; Pillow smoothing otherwise. Not AI RAW denoise.
                    These optional filters process an 8-bit image.
                  </small>
                  {settings.aiDenoise &&
                  denoiseEngine &&
                  denoiseEngine !== "Off" ? (
                    <small className="quick-hint">
                      Preview used: {denoiseEngine}
                    </small>
                  ) : null}
                  <label className="quick-check">
                    <input
                      type="checkbox"
                      checked={settings.upscale}
                      onChange={(event) =>
                        onSettingsChange({
                          ...settings,
                          upscale: event.target.checked,
                        })
                      }
                    />{" "}
                    Real-ESRGAN upscale
                  </label>
                  <select
                    className="ui-select"
                    aria-label="Upscale factor"
                    disabled={!settings.upscale}
                    value={settings.upscaleScale}
                    onChange={(event) =>
                      onSettingsChange({
                        ...settings,
                        upscaleScale: Number(event.target.value) as 2 | 4,
                      })
                    }
                  >
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                  </select>
                  <small className="quick-hint">
                    Requires the optional AI runtime. Upscaling is separate from
                    color and noise reduction.
                  </small>
                </details>
              </>
            )}
            <details className="quick-section" open>
              <summary>Export</summary>
              <div className="quick-button-row">
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() =>
                    onSettingsChange({
                      ...settings,
                      outputFormat: "jpeg",
                      quality: 92,
                      resizeMaxEdge: 2560,
                      upscale: false,
                    })
                  }
                >
                  Share JPEG
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() =>
                    onSettingsChange({
                      ...settings,
                      outputFormat: "tiff",
                      resizeMaxEdge: null,
                      upscale: false,
                    })
                  }
                >
                  Archive TIFF
                </button>
              </div>
              <label className="quick-form-field">
                Format
                <select
                  className="ui-select"
                  value={settings.outputFormat}
                  onChange={(event) =>
                    onSettingsChange({
                      ...settings,
                      outputFormat: event.target.value as "jpeg" | "tiff",
                    })
                  }
                >
                  <option value="jpeg">JPEG · sRGB</option>
                  <option value="tiff">TIFF · 16-bit sRGB</option>
                </select>
              </label>
              {settings.outputFormat === "jpeg" ? (
                <Slider
                  label="JPEG quality"
                  value={settings.quality / 100}
                  min={0.01}
                  reset={0.92}
                  onBegin={onBeginAdjustment}
                  onEnd={onEndAdjustment}
                  onChange={(value) =>
                    onSettingsChange({
                      ...settings,
                      quality: Math.round(value * 100),
                    })
                  }
                />
              ) : null}
              <label className="quick-form-field">
                Longest edge
                <select
                  className="ui-select"
                  value={settings.resizeMaxEdge ?? "original"}
                  onChange={(event) =>
                    onSettingsChange({
                      ...settings,
                      resizeMaxEdge:
                        event.target.value === "original"
                          ? null
                          : Number(event.target.value),
                    })
                  }
                >
                  <option value="original">Original resolution</option>
                  <option value={2048}>2048 px</option>
                  <option value={2560}>2560 px</option>
                  <option value={3840}>3840 px</option>
                  {settings.resizeMaxEdge &&
                  ![2048, 2560, 3840].includes(settings.resizeMaxEdge) ? (
                    <option value={settings.resizeMaxEdge}>
                      {settings.resizeMaxEdge} px
                    </option>
                  ) : null}
                </select>
              </label>
              <label className="quick-form-field">
                Folder
                <input
                  className="ui-input"
                  value={props.outputFolder}
                  placeholder="Choose a destination…"
                  onChange={(event) =>
                    props.onOutputFolderChange(event.target.value)
                  }
                />
              </label>
              <small className="quick-hint">
                Export uses each photo’s saved settings. Originals stay intact.
                Camera, exposure, date and author metadata are retained. GPS is
                omitted.
              </small>
            </details>
          </fieldset>
          {notice ? (
            <p className="quick-notice" role="status">
              {notice}
            </p>
          ) : null}
        </aside>
      </div>
      <footer className="quick-footer">
        <div role="status">
          {props.saveState === "failed" ? (
            <>
              <span role="alert">
                {props.saveError} · Keep this window open.
              </span>{" "}
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={props.onRetrySave}
              >
                Retry save
              </button>
            </>
          ) : (
            <>
              {props.saveState === "saving" ? "Saving…" : "Edits saved"}
              {props.job ? (
                <>
                  {" "}
                  · <strong>{props.job.status}</strong> · {props.job.completed}{" "}
                  exported
                  {props.job.failed ? ` · ${props.job.failed} failed` : ""}
                  {props.job.current ? ` · ${props.job.current}` : ""}
                </>
              ) : (
                ` · ${modPrefix}Z Undo · ${shiftModPrefix}Z Redo`
              )}
            </>
          )}
        </div>
        {running ? (
          <>
            <progress max={100} value={progress} />
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              onClick={props.onCancel}
            >
              Cancel export
            </button>
          </>
        ) : (
          <>
            {props.job?.resumable ? (
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                onClick={() => props.onResume(false)}
              >
                Resume export ({props.job.pending} left)
              </button>
            ) : null}
            {props.job?.failed ? (
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => props.onResume(true)}
              >
                Retry {props.job.failed} failed
              </button>
            ) : null}
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              disabled={!queued.length}
              onClick={props.onClearQueue}
            >
              Clear queue
            </button>
          </>
        )}
        {props.job?.failures.length ? (
          <details>
            <summary>Export errors</summary>
            {props.job.failures.map((failure, i) => (
              <p key={i}>
                {failure.name}: {failure.error}
              </p>
            ))}
          </details>
        ) : null}
        {props.job?.processingNotes?.length ? (
          <span>{props.job.processingNotes.join(" · ")}</span>
        ) : null}
      </footer>
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ExportEnhanceJob,
  ExportEnhanceSettings,
  Photo,
  PhotoStylePreset,
} from "../../types";
import { renderEditingPreview } from "../../api";
import {
  adjustmentGroups,
  autoStrength,
  cloneSettings,
  defaultSettings,
  geometry,
  pasteSettings,
  presets,
  quickKeys,
  type AdjustmentGroup,
} from "../../editing/recipe";
import {
  EditingRenderer,
  loadEditingBase,
  type EditingBase,
} from "../../editing/renderer";
import { Button } from "../ui/button";
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
  light: "Light",
  color: "Color",
  style: "Style",
  detail: "Detail",
  exposure: "Exposure",
  whiteBalance: "Warmth",
  crop: "Crop",
  output: "Export settings",
};
const PRESET_STORAGE = "photo-cull.editing-presets.v2";
type SavedPreset = { name: string; settings: ExportEnhanceSettings };
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
          {max === 3
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
  onError,
  className = "",
}: {
  base: EditingBase;
  settings: ExportEnhanceSettings;
  original?: boolean;
  clipping?: boolean;
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
        renderer.current?.draw(settings, original, clipping);
      } catch (error) {
        onError?.(
          error instanceof Error ? error.message : "Preview unavailable",
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [base, settings, original, clipping, generation, onError]);
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
    [grid, setGrid] = useState(false);
  const [backendState, setBackendState] = useState<{
      key: string;
      url: string;
    } | null>(null),
    [rendering, setRendering] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [denoiseEngine, setDenoiseEngine] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
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
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() => {
    try {
      const list = JSON.parse(localStorage.getItem(PRESET_STORAGE) ?? "[]");
      return Array.isArray(list)
        ? list.filter(
            (p) =>
              typeof p.name === "string" && p.settings?.recipeVersion === 2,
          )
        : [];
    } catch {
      return [];
    }
  });
  const [presetName, setPresetName] = useState("");
  const [notice, setNotice] = useState("");
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
  const frame = base
    ? geometry(base.width, base.height, settings.crop)
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
    if (!photo) return;
    const controller = new AbortController();
    setBaseError("");
    setGpuError("");
    setOriginal(false);
    setAutoBusy(false);
    loadEditingBase(photo.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setBaseState({ key: photoKey, base: value });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setBaseError(error.message);
      });
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) props.onRedo();
        else props.onUndo();
      }
      if (event.key === "Escape") props.onPreviewOpenChange(false);
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
    onSettingsChange({ ...settings, [key]: value, auto: null });
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
      const baseControls = Object.fromEntries(
        quickKeys.map((k) => [k, before[k]]),
      );
      const target = Object.fromEntries(
        quickKeys.map((k) => [
          k,
          k === "temperature"
            ? before[k]
            : Math.max(
                k === "exposure" ? -3 : -1,
                Math.min(k === "exposure" ? 3 : 1, before[k] + suggestions[k]),
              ),
        ]),
      );
      onSettingsChange(
        autoStrength(
          { ...before, auto: { base: baseControls, target, strength: 1 } },
          1,
        ),
      );
    } catch (error) {
      if (currentPhoto.current === key)
        setNotice(
          error instanceof Error ? error.message : "Auto enhance failed",
        );
    } finally {
      if (currentPhoto.current === key) setAutoBusy(false);
    }
  };
  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const next = [
      ...savedPresets.filter((p) => p.name !== name),
      { name, settings: cloneSettings(settings) },
    ];
    try {
      localStorage.setItem(PRESET_STORAGE, JSON.stringify(next));
      setSavedPresets(next);
      setPresetName("");
      setNotice(`Saved “${name}”`);
    } catch {
      setNotice("Unable to save preset on this device");
    }
  };
  const preview = photo ? (
    <div
      className={`quick-image ${grid ? "show-grid" : ""}`}
      style={{
        width: Math.max(1, frame.width * frameScale),
        height: Math.max(1, frame.height * frameScale),
      }}
    >
      {base && !legacy ? (
        <PreviewCanvas
          base={base}
          settings={settings}
          original={original}
          clipping={clipping}
          onError={onGpuError}
        />
      ) : null}
      {backendPreview && !original ? (
        <img
          className="quick-rendered"
          src={backendPreview}
          alt={`${photo.name} edited`}
        />
      ) : null}
      {base && gpuError && !legacy && (!backendPreview || original) ? (
        <NeutralCanvas base={base} crop={settings.crop} />
      ) : null}
      {(!base || legacy) && (!backendPreview || original) ? (
        <img src={photo.url} alt={photo.name} />
      ) : null}
      {grid ? (
        <div className="quick-grid" aria-hidden="true">
          <i />
          <i />
          <b />
          <b />
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className={`quick-editor ${props.isPreviewOpen ? "expanded" : ""}`}>
      <header className="quick-toolbar">
        <div>
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
          <Button variant="outline" size="sm" onClick={props.onChooseFolder}>
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
                {preview}
              </div>
              <div className="quick-stage-tools">
                <button
                  type="button"
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
            {legacy ? (
              <div className="quick-legacy">
                <strong>Legacy edit preserved</strong>
                <p>
                  This photo uses the previous color engine. Switch to the new
                  controls to start a neutral edit. Undo restores this recipe.
                </p>
                <Button
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
                    <button
                      type="button"
                      className="quick-auto"
                      disabled={autoBusy || !base}
                      onClick={() => void auto()}
                    >
                      {autoBusy ? "Analyzing…" : "✧ Auto"}
                    </button>
                  </div>
                  {settings.auto ? (
                    <Slider
                      label="Auto strength"
                      value={settings.auto.strength}
                      min={0}
                      onBegin={onBeginAdjustment}
                      onEnd={onEndAdjustment}
                      onChange={(value) =>
                        onSettingsChange(autoStrength(settings, value))
                      }
                    />
                  ) : null}
                  {quickKeys.map(slider)}
                  <small className="quick-hint">
                    Double-click a slider to reset it.
                  </small>
                </section>
                <details className="quick-section" open>
                  <summary>Styles</summary>
                  <div className="quick-styles">
                    {Object.entries(presets).map(([id, preset]) => (
                      <button
                        type="button"
                        className={
                          settings.photoStyle.preset === id ? "active" : ""
                        }
                        aria-pressed={settings.photoStyle.preset === id}
                        key={id}
                        onClick={() =>
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
                      >
                        {thumbnailBase ? (
                          <PreviewCanvas
                            base={thumbnailBase}
                            settings={thumbnailSettings[id]}
                          />
                        ) : (
                          <span className="quick-style-placeholder" />
                        )}
                        <span>{preset.label}</span>
                      </button>
                    ))}
                  </div>
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
                <details
                  className="quick-section"
                  onToggle={(event) => setGrid(event.currentTarget.open)}
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
                      updateCrop({ ...settings.crop, angle: value * 15 })
                    }
                  />
                  <span className="quick-hint">
                    {settings.crop.angle.toFixed(1)}° · edges automatically fit
                    inside the photo
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
                      onClick={() => {
                        setCopy(cloneSettings(settings));
                        setNotice("Adjustments copied");
                      }}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
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
                      disabled={queued.length < 2 || !groups.length}
                      onClick={() => props.onApplyToQueued(settings, groups)}
                    >
                      Apply to queue
                    </button>
                  </div>
                  <div className="quick-preset-save">
                    <input
                      aria-label="Preset name"
                      placeholder="Name this look"
                      value={presetName}
                      onChange={(event) => setPresetName(event.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!presetName.trim()}
                      onClick={savePreset}
                    >
                      Save
                    </button>
                  </div>
                  {savedPresets.map((preset) => (
                    <div className="quick-saved-preset" key={preset.name}>
                      <button
                        type="button"
                        onClick={() =>
                          onSettingsChange(
                            pasteSettings(settings, preset.settings, groups),
                          )
                        }
                      >
                        {preset.name}
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete preset ${preset.name}`}
                        onClick={() => {
                          const next = savedPresets.filter(
                            (p) => p.name !== preset.name,
                          );
                          try {
                            localStorage.setItem(
                              PRESET_STORAGE,
                              JSON.stringify(next),
                            );
                            setSavedPresets(next);
                          } catch {
                            setNotice("Unable to remove preset");
                          }
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <small className="quick-hint">
                    Exposure, warmth and crop stay individual unless selected
                    above. Presets are saved on this device.
                  </small>
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
              <button type="button" onClick={props.onRetrySave}>
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
                " · ⌘Z Undo · ⇧⌘Z Redo"
              )}
            </>
          )}
        </div>
        {running ? (
          <>
            <progress max={100} value={progress} />
            <button type="button" onClick={props.onCancel}>
              Cancel export
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={!queued.length}
            onClick={props.onClearQueue}
          >
            Clear queue
          </button>
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

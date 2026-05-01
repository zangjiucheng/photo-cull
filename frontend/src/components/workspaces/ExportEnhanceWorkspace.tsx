import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { ExportEnhanceJob, ExportEnhanceSettings, Photo, PhotoStyle, PhotoStylePreset, StyleMaskPayload } from "../../types";
import { Button } from "../ui/button";

interface ExportEnhanceWorkspaceProps {
  photos: Photo[];
  queuedIds: string[];
  selectedPhotoId: string | null;
  settings: ExportEnhanceSettings;
  outputFolder: string;
  job: ExportEnhanceJob | null;
  isStarting: boolean;
  renderedPreviewUrl: string | null;
  isRenderingPreview: boolean;
  renderPreviewProgress: number;
  renderPreviewStage: string;
  previewError: string;
  styleMasks: StyleMaskPayload | null;
  isLoadingStyleMasks: boolean;
  isPreviewOpen: boolean;
  onSettingsChange: (settings: ExportEnhanceSettings) => void;
  onSelectPreviewPhoto: (photoId: string) => void;
  onChooseFolder: () => void;
  onOutputFolderChange: (path: string) => void;
  onRenderPreview: (photoId: string) => void;
  onPreviewOpenChange: (open: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
}

const stylePresets: Array<{ id: PhotoStylePreset; label: string }> = [
  { id: "standard", label: "Standard" },
  { id: "bright", label: "Bright" },
  { id: "dramatic", label: "Dramatic" },
  { id: "warm", label: "Warm" },
  { id: "cool", label: "Cool" },
  { id: "muted", label: "Muted" }
];

const shaderPresetIndex: Record<PhotoStylePreset, number> = {
  standard: 0,
  bright: 1,
  dramatic: 2,
  warm: 3,
  cool: 4,
  muted: 5
};

function Field({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="enhance-field">
      <span>{label}<strong>{value}</strong></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function ToneColourPad({ style, onChange }: { style: PhotoStyle; onChange: (style: PhotoStyle) => void }) {
  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    onChange({ ...style, colour: Math.round(x * 200 - 100), tone: Math.round((1 - y) * 200 - 100) });
  };
  return (
    <div
      className="tone-colour-pad"
      role="slider"
      tabIndex={0}
      aria-label="Tone and colour"
      aria-valuetext={`Tone ${style.tone}, Colour ${style.colour}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) updateFromPointer(event);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 2;
        if (event.key === "ArrowLeft") onChange({ ...style, colour: Math.max(-100, style.colour - step) });
        if (event.key === "ArrowRight") onChange({ ...style, colour: Math.min(100, style.colour + step) });
        if (event.key === "ArrowUp") onChange({ ...style, tone: Math.min(100, style.tone + step) });
        if (event.key === "ArrowDown") onChange({ ...style, tone: Math.max(-100, style.tone - step) });
      }}
    >
      <span className="tone-colour-crosshair" style={{ left: `${(style.colour + 100) / 2}%`, top: `${100 - (style.tone + 100) / 2}%` }} />
      <em className="tone-label top">More Tone</em>
      <em className="tone-label bottom">Softer</em>
      <em className="tone-label left">Cooler</em>
      <em className="tone-label right">Warmer</em>
    </div>
  );
}

const vertexShaderSource = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision mediump float;
uniform sampler2D uImage;
uniform sampler2D uMasks;
uniform int uPreset;
uniform float uTone;
uniform float uColour;
uniform float uPalette;
varying vec2 vUv;

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float smoothMask(float edge0, float edge1, float value) {
  float t = clamp((value - edge0) / max(edge1 - edge0, 0.0001), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
vec3 saturateColor(vec3 c, float factor) {
  float g = dot(c, vec3(0.299, 0.587, 0.114));
  return clamp(vec3(g) + (c - vec3(g)) * factor, 0.0, 1.0);
}
vec3 vibrance(vec3 c, float amount) {
  float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  float factor = 1.0 + amount * (1.0 - clamp(sat * 1.4, 0.0, 1.0));
  return saturateColor(c, factor);
}
mat3 presetMatrix(int preset) {
  if (preset == 1) return mat3(1.04,-0.01,-0.01, -0.01,1.03,-0.01, -0.01,-0.01,1.02);
  if (preset == 2) return mat3(1.10,-0.03,-0.02, -0.04,1.06,-0.03, -0.02,-0.02,1.12);
  if (preset == 3) return mat3(1.08,0.00,-0.03, 0.01,1.02,0.00, -0.02,0.00,0.98);
  if (preset == 4) return mat3(0.98,0.00,-0.02, 0.00,1.03,0.01, -0.02,0.00,1.09);
  if (preset == 5) return mat3(1.02,0.01,0.00, 0.01,1.02,0.00, 0.00,0.00,1.02);
  return mat3(1.0);
}
vec4 presetValues(int preset) {
  if (preset == 1) return vec4(0.08, 0.10, 0.03, 0.06);
  if (preset == 2) return vec4(0.05, 0.04, -0.02, 0.22);
  if (preset == 3) return vec4(0.07, 0.08, 0.12, 0.07);
  if (preset == 4) return vec4(0.04, 0.06, -0.12, 0.08);
  if (preset == 5) return vec4(-0.16, -0.08, 0.02, -0.04);
  return vec4(0.0);
}
void main() {
  vec3 original = texture2D(uImage, vUv).rgb;
  vec4 masks = texture2D(uMasks, vUv);
  float skin = masks.r;
  float sky = masks.g;
  float foliage = masks.b;
  vec4 p = presetValues(uPreset);
  vec3 styled = clamp(presetMatrix(uPreset) * original, 0.0, 1.0);
  float y = luminance(styled);
  float tone = clamp(uTone / 100.0, -1.0, 1.0);
  float colour = clamp(uColour / 100.0, -1.0, 1.0);
  float contrast = 1.0 + p.a + max(tone, 0.0) * 0.32 + min(tone, 0.0) * 0.18;
  styled = clamp((styled - 0.5) * contrast + 0.5, 0.0, 1.0);
  float shadow = 1.0 - smoothMask(0.0, 0.42, y);
  float midtone = smoothMask(0.20, 0.50, y) * (1.0 - smoothMask(0.55, 0.86, y));
  float highlight = smoothMask(0.58, 1.0, y);
  styled += tone > 0.0 ? (-highlight * tone * 0.08 + midtone * tone * 0.04) : (shadow * -tone * 0.12 - midtone * -tone * 0.03);
  styled = saturateColor(clamp(styled, 0.0, 1.0), 1.0 + p.r + colour * 0.24);
  styled = vibrance(styled, p.g + abs(colour) * 0.12);
  styled += vec3(0.08, 0.025, -0.07) * (p.b + colour * 0.12);
  styled += sky * vec3(-0.025, 0.01, 0.07);
  styled += foliage * vec3(-0.015, 0.055, -0.015);
  styled = clamp(styled, 0.0, 1.0);
  vec3 skinSafe = saturateColor(styled, max(0.72, 1.0 + p.r * 0.25 + colour * 0.08));
  styled = mix(styled, skinSafe, skin * 0.35);
  styled = mix(styled, original, skin * 0.50);
  gl_FragColor = vec4(mix(original, styled, clamp(uPalette / 100.0, 0.0, 1.0)), 1.0);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "WebGL shader compile failed");
  }
  return shader;
}

function PhotographicStyleCanvas({ photo, style, masks, onUnavailable }: {
  photo: Photo;
  style: PhotoStyle;
  masks: StyleMaskPayload | null;
  onUnavailable: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl");
    if (!gl) {
      onUnavailable("WebGL preview unavailable. Use Render Preview for the backend pipeline.");
      return;
    }
    let disposed = false;
    const image = new Image();
    const maskImage = new Image();
    image.crossOrigin = "anonymous";
    maskImage.crossOrigin = "anonymous";
    const render = () => {
      if (disposed || !image.complete || !maskImage.complete) return;
      const maxWidth = 900;
      const scale = Math.min(1, maxWidth / image.naturalWidth);
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const program = gl.createProgram();
      if (!program) return;
      const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        onUnavailable(gl.getProgramInfoLog(program) || "WebGL program failed");
        return;
      }
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "aPosition");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const makeTexture = (unit: number, source: TexImageSource) => {
        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      };
      makeTexture(0, image);
      makeTexture(1, maskImage);
      gl.uniform1i(gl.getUniformLocation(program, "uImage"), 0);
      gl.uniform1i(gl.getUniformLocation(program, "uMasks"), 1);
      gl.uniform1i(gl.getUniformLocation(program, "uPreset"), shaderPresetIndex[style.preset]);
      gl.uniform1f(gl.getUniformLocation(program, "uTone"), style.tone);
      gl.uniform1f(gl.getUniformLocation(program, "uColour"), style.colour);
      gl.uniform1f(gl.getUniformLocation(program, "uPalette"), style.palette);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    image.onload = render;
    maskImage.onload = render;
    image.src = photo.url;
    maskImage.src = masks?.dataUrl ?? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    return () => {
      disposed = true;
    };
  }, [masks, onUnavailable, photo, style]);
  return <canvas ref={canvasRef} className="enhance-preview-canvas" aria-label="Photographic style preview" />;
}

export function ExportEnhanceWorkspace({
  photos,
  queuedIds,
  selectedPhotoId,
  settings,
  outputFolder,
  job,
  isStarting,
  renderedPreviewUrl,
  isRenderingPreview,
  renderPreviewProgress,
  renderPreviewStage,
  previewError,
  styleMasks,
  isLoadingStyleMasks,
  isPreviewOpen,
  onSettingsChange,
  onSelectPreviewPhoto,
  onChooseFolder,
  onOutputFolderChange,
  onRenderPreview,
  onPreviewOpenChange,
  onStart,
  onCancel
}: ExportEnhanceWorkspaceProps) {
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const queuedPhotos = queuedIds.map((id) => byId.get(id)).filter((photo): photo is Photo => Boolean(photo));
  const progress = job?.total ? Math.round(((job.completed + job.failed) / job.total) * 100) : 0;
  const running = job?.status === "queued" || job?.status === "running";
  const update = <K extends keyof ExportEnhanceSettings>(key: K, value: ExportEnhanceSettings[K]) => onSettingsChange({ ...settings, [key]: value });
  const updateStyle = (photoStyle: PhotoStyle) => onSettingsChange({ ...settings, photoStyle });
  const previewPhoto = queuedPhotos.find((photo) => photo.id === selectedPhotoId) ?? queuedPhotos[0] ?? null;
  const currentIndex = previewPhoto ? queuedPhotos.findIndex((photo) => photo.id === previewPhoto.id) : -1;
  const [previewFallback, setPreviewFallback] = useState("");

  useEffect(() => {
    if (!isPreviewOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onPreviewOpenChange(false);
        return;
      }
      if ((event.key === "h" || event.key === "H" || event.key === "ArrowLeft") && currentIndex > 0) {
        event.preventDefault();
        onSelectPreviewPhoto(queuedPhotos[currentIndex - 1].id);
      }
      if ((event.key === "l" || event.key === "L" || event.key === "ArrowRight") && currentIndex >= 0 && currentIndex < queuedPhotos.length - 1) {
        event.preventDefault();
        onSelectPreviewPhoto(queuedPhotos[currentIndex + 1].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentIndex, isPreviewOpen, onPreviewOpenChange, onSelectPreviewPhoto, queuedPhotos]);

  return (
    <div className="workspace-panel export-enhance-workspace">
      <div className="workspace-head enhance-head">
        <div>
          <span className="panel-kicker">Enhance & Export</span>
          <h2>{queuedPhotos.length} queued photo(s)</h2>
          <p>Apply color, optional Restormer restoration, and save enhanced files to a folder.</p>
        </div>
        <div className="workspace-actions">
          <Button variant="outline" onClick={onChooseFolder}>Output Folder</Button>
          <Button variant="default" onClick={onStart} disabled={isStarting || running || !queuedPhotos.length || !outputFolder}>
            {isStarting ? "Starting..." : "Start Enhance"}
          </Button>
        </div>
      </div>

      <section className="enhance-preview-zone" aria-label="Enhance and export color preview">
        {previewPhoto ? (
          <>
            <div className="enhance-preview-main">
              <div className="enhance-preview-frame">
                <button type="button" className="enhance-preview-open" onClick={() => onPreviewOpenChange(true)} aria-label="Open enhance preview">
                  {renderedPreviewUrl ? (
                    <img src={renderedPreviewUrl} alt={previewPhoto.name} />
                  ) : (
                    <PhotographicStyleCanvas
                      photo={previewPhoto}
                      style={settings.photoStyle}
                      masks={styleMasks}
                      onUnavailable={setPreviewFallback}
                    />
                  )}
                </button>
              </div>
              <div className="enhance-preview-meta">
                <span className="panel-kicker">Photographic Style</span>
                <strong>{previewPhoto.name}</strong>
                <p>{renderedPreviewUrl ? "Showing rendered preview from the backend pipeline." : "WebGL2 preview updates from Tone, Colour, Palette, and semantic masks."}</p>
                {isLoadingStyleMasks ? <span className="enhance-preview-note">Loading semantic masks...</span> : null}
                {previewFallback ? <span className="enhance-preview-error">{previewFallback}</span> : null}
                <Button variant="outline" size="sm" onClick={() => onRenderPreview(previewPhoto.id)} disabled={isRenderingPreview}>
                  {isRenderingPreview ? "Rendering..." : "Render Preview"}
                </Button>
                {isRenderingPreview ? (
                  <div className="enhance-render-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={renderPreviewProgress}>
                    <span><i style={{ width: `${renderPreviewProgress}%` }} /></span>
                    <em>{renderPreviewStage}</em>
                  </div>
                ) : null}
                {previewError ? <span className="enhance-preview-error">{previewError}</span> : null}
              </div>
            </div>
            <div className="enhance-preview-strip">
              {queuedPhotos.slice(0, 12).map((photo) => (
                <button className={`enhance-preview-card ${photo.id === previewPhoto.id ? "active" : ""}`.trim()} key={photo.id} type="button" onClick={() => onSelectPreviewPhoto(photo.id)}>
                  <img src={photo.url} alt={photo.name} loading="lazy" />
                  <span title={photo.name}>{photo.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="enhance-preview-empty">Add photos to the export queue to preview enhance inputs.</div>
        )}
      </section>

      {isPreviewOpen && previewPhoto ? (
        <div className="enhance-lightbox" role="dialog" aria-modal="true" aria-label="Enhance enlarged preview" onClick={() => onPreviewOpenChange(false)}>
          <button className="enhance-lightbox-close" type="button" onClick={() => onPreviewOpenChange(false)} aria-label="Close preview">Close</button>
          <button
            className="enhance-lightbox-nav left"
            type="button"
            disabled={currentIndex <= 0}
            onClick={(event) => {
              event.stopPropagation();
              if (currentIndex > 0) onSelectPreviewPhoto(queuedPhotos[currentIndex - 1].id);
            }}
            aria-label="Previous photo"
          >
            ‹
          </button>
          <img
            src={renderedPreviewUrl ?? previewPhoto.url}
            alt={previewPhoto.name}
            onClick={(event) => event.stopPropagation()}
          />
          <button
            className="enhance-lightbox-nav right"
            type="button"
            disabled={currentIndex < 0 || currentIndex >= queuedPhotos.length - 1}
            onClick={(event) => {
              event.stopPropagation();
              if (currentIndex < queuedPhotos.length - 1) onSelectPreviewPhoto(queuedPhotos[currentIndex + 1].id);
            }}
            aria-label="Next photo"
          >
            ›
          </button>
          <div className="enhance-lightbox-caption">{previewPhoto.name} · {currentIndex + 1}/{queuedPhotos.length}</div>
        </div>
      ) : null}

      <section className="enhance-grid">
        <div className="enhance-panel">
          <div className="enhance-panel-head"><strong>Photographic Style</strong></div>
          <div className="enhance-presets">
            {stylePresets.map((preset) => (
              <button
                className={settings.photoStyle.preset === preset.id ? "active" : ""}
                key={preset.id}
                type="button"
                onClick={() => updateStyle({ ...settings.photoStyle, preset: preset.id })}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="enhance-panel">
          <div className="enhance-panel-head"><strong>Tone / Colour</strong><span>{settings.photoStyle.tone} / {settings.photoStyle.colour}</span></div>
          <ToneColourPad style={settings.photoStyle} onChange={updateStyle} />
          <Field label="Palette" value={settings.photoStyle.palette} min={0} max={100} step={1} onChange={(value) => updateStyle({ ...settings.photoStyle, palette: value })} />
        </div>

        <div className="enhance-panel">
          <div className="enhance-panel-head"><strong>AI Restore</strong></div>
          <label className="enhance-check"><input type="checkbox" checked={settings.aiDenoise} onChange={(event) => update("aiDenoise", event.target.checked)} /> AI Denoise</label>
          <label className="enhance-check"><input type="checkbox" checked={settings.aiDeblur} onChange={(event) => update("aiDeblur", event.target.checked)} /> AI Deblur</label>
          <label className="enhance-select">Strength
            <select value={settings.strength} onChange={(event) => update("strength", event.target.value as ExportEnhanceSettings["strength"])}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <Field label="Sharpen" value={settings.sharpen} min={0} max={1} step={0.05} onChange={(value) => update("sharpen", value)} />
        </div>

        <div className="enhance-panel">
          <div className="enhance-panel-head"><strong>Output</strong></div>
          <label className="enhance-select">Format
            <select value={settings.outputFormat} onChange={(event) => update("outputFormat", event.target.value as ExportEnhanceSettings["outputFormat"])}>
              <option value="jpeg">JPEG</option>
              <option value="tiff">TIFF 16-bit</option>
            </select>
          </label>
          <Field label="Quality" value={settings.quality} min={1} max={100} step={1} onChange={(value) => update("quality", value)} />
          <label className="enhance-select">Resize max edge
            <input type="number" min={256} placeholder="Original" value={settings.resizeMaxEdge ?? ""} onChange={(event) => update("resizeMaxEdge", event.target.value ? Number(event.target.value) : null)} />
          </label>
          <label className="enhance-select">Folder
            <input value={outputFolder} onChange={(event) => onOutputFolderChange(event.target.value)} placeholder="Choose an output folder" />
          </label>
        </div>
      </section>

      <section className="enhance-progress">
        <div className="enhance-progress-head">
          <strong>{job ? `Job ${job.status}` : "No Enhance & Export job yet"}</strong>
          {running ? <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button> : null}
        </div>
        <div className="enhance-progress-bar"><span style={{ width: `${progress}%` }} /></div>
        <p>{job ? `${job.completed} complete, ${job.failed} failed, ${job.total} total${job.current ? ` · ${job.current}` : ""}` : "Configure settings and start a batch."}</p>
        {job?.outputs.length ? <div className="enhance-output-list">{job.outputs.slice(-5).map((output) => <span key={output}>{output}</span>)}</div> : null}
        {job?.failures.length ? <div className="enhance-failures">{job.failures.map((failure, index) => <span key={`${failure.name}-${index}`}>{failure.name}: {failure.error}</span>)}</div> : null}
      </section>
    </div>
  );
}

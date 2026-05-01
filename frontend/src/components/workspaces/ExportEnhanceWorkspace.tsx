import { useEffect } from "react";
import type { ExportEnhanceJob, ExportEnhanceSettings, Photo } from "../../types";
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

const presets: Record<string, Partial<ExportEnhanceSettings>> = {
  Natural: { exposure: 0, contrast: 0.05, highlights: -0.05, shadows: 0.08, saturation: 0.06, temperature: 0, tint: 0, sharpen: 0.15 },
  "Bright Clean": { exposure: 0.25, contrast: 0.08, highlights: -0.18, shadows: 0.18, saturation: 0.08, temperature: 0.02, tint: 0, sharpen: 0.2 },
  "Film Soft": { exposure: 0.05, contrast: -0.08, highlights: -0.12, shadows: 0.12, saturation: -0.08, temperature: 0.08, tint: 0.02, sharpen: 0.05 },
  "High Contrast": { exposure: 0, contrast: 0.28, highlights: -0.08, shadows: -0.05, saturation: 0.12, temperature: 0, tint: 0, sharpen: 0.25 }
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
  const previewPhoto = queuedPhotos.find((photo) => photo.id === selectedPhotoId) ?? queuedPhotos[0] ?? null;
  const previewFilter = [
    `brightness(${Math.max(0.25, 1 + settings.exposure * 0.22 + settings.shadows * 0.08 + settings.highlights * 0.06)})`,
    `contrast(${Math.max(0.25, 1 + settings.contrast * 0.45)})`,
    `saturate(${Math.max(0, 1 + settings.saturation * 0.7)})`,
    `sepia(${Math.max(0, settings.temperature) * 0.16})`,
    `hue-rotate(${settings.tint * 10}deg)`
  ].join(" ");
  const previewOverlayOpacity = Math.min(0.18, Math.abs(settings.temperature) * 0.12 + Math.abs(settings.tint) * 0.08);
  const previewOverlayColor = settings.temperature >= 0 ? "255, 176, 92" : "92, 176, 255";
  const currentIndex = previewPhoto ? queuedPhotos.findIndex((photo) => photo.id === previewPhoto.id) : -1;

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
                  <img src={renderedPreviewUrl ?? previewPhoto.url} alt={previewPhoto.name} style={renderedPreviewUrl ? undefined : { filter: previewFilter }} />
                </button>
                {renderedPreviewUrl ? null : <span style={{ background: `rgba(${previewOverlayColor}, ${previewOverlayOpacity})` }} />}
              </div>
              <div className="enhance-preview-meta">
                <span className="panel-kicker">Color Preview</span>
                <strong>{previewPhoto.name}</strong>
                <p>{renderedPreviewUrl ? "Showing rendered preview from the backend pipeline." : "Preview updates immediately from color controls. Use Render Preview for the real pipeline."}</p>
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
                  <img src={photo.url} alt={photo.name} loading="lazy" style={{ filter: previewFilter }} />
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
            style={renderedPreviewUrl ? undefined : { filter: previewFilter }}
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
          <div className="enhance-panel-head"><strong>Presets</strong></div>
          <div className="enhance-presets">
            {Object.entries(presets).map(([name, values]) => (
              <button key={name} type="button" onClick={() => onSettingsChange({ ...settings, ...values })}>{name}</button>
            ))}
          </div>
        </div>

        <div className="enhance-panel">
          <div className="enhance-panel-head"><strong>Color</strong></div>
          <Field label="Exposure" value={settings.exposure} min={-2} max={2} step={0.05} onChange={(value) => update("exposure", value)} />
          <Field label="Contrast" value={settings.contrast} min={-1} max={1} step={0.05} onChange={(value) => update("contrast", value)} />
          <Field label="Highlights" value={settings.highlights} min={-1} max={1} step={0.05} onChange={(value) => update("highlights", value)} />
          <Field label="Shadows" value={settings.shadows} min={-1} max={1} step={0.05} onChange={(value) => update("shadows", value)} />
          <Field label="Saturation" value={settings.saturation} min={-1} max={1} step={0.05} onChange={(value) => update("saturation", value)} />
          <Field label="Temperature" value={settings.temperature} min={-1} max={1} step={0.05} onChange={(value) => update("temperature", value)} />
          <Field label="Tint" value={settings.tint} min={-1} max={1} step={0.05} onChange={(value) => update("tint", value)} />
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

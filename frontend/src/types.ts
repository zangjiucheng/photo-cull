export interface ApiPhoto {
  id: string;
  workspaceId: string;
  name: string;
  score: number | null;
  scoreDetails: ScoreDetails | null;
  manualScore: number | null;
  orientationOverride: 0 | 90 | 180 | 270 | null;
  path: string;
  url: string;
  folder: string;
  folderPath: string;
  relativePath: string;
  mtime: number;
  size: number;
  decision: "accepted" | "rejected" | null;
  rating: number | null;
  status: "pending" | "processing" | "done" | "error";
  error?: string | null;
}

export interface ScoreMetricDetail {
  group?: string;
  weight?: number;
  lowerBetter?: boolean;
  scoreRange?: [number, number] | number[];
  raw?: number;
  normalized?: number;
  status?: "ok" | "error" | string;
  error?: string;
}

export interface ScoreDetails {
  mode?: string;
  final?: number;
  metrics?: Record<string, ScoreMetricDetail>;
  heuristics?: Record<string, number>;
  errors?: Record<string, string>;
  raw?: string;
}

export interface Photo extends ApiPhoto {
  aiScore: number;
  burstKey: string;
  rejected: boolean;
}

export interface LibraryFolder {
  path: string;
  name: string;
  count: number;
  bestScore: number;
  mtime: number;
}

export interface PhotoWorkspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
  lastScannedAt: number | null;
  /** False when the folder moved or its disk is not mounted. */
  folderFound?: boolean;
}

export interface LibraryPayload {
  activeWorkspace: PhotoWorkspace | null;
  workspaces: PhotoWorkspace[];
  folders: LibraryFolder[];
  photos: ApiPhoto[];
  summary: {
    pending: number;
    processing: number;
    done: number;
    error: number;
    scoreMode?: string;
    excluded?: number;
    indexing?: {
      active: boolean;
      indexed: number;
      totalDiscovered: number;
      status: "idle" | "indexing" | "done" | "error";
      startedAt?: number | null;
      finishedAt?: number | null;
      error?: string | null;
    };
  };
  exportQueue?: string[];
  exportEnhanceSettings?: Record<string, ExportEnhanceSettings>;
  rescore?: {
    queued: number;
    reset: number;
  };
}

export interface SimilarGroupPayload {
  id: string;
  stage: "phash" | "clip" | "mixed";
  tier: "duplicate" | "similar" | "review";
  keepPhotoId: string;
  photoIds: string[];
  maxDistance: number | null;
  maxSimilarity: number | null;
  matches: Array<{
    left: string;
    right: string;
    method: "phash" | "clip";
    tier: "duplicate" | "similar" | "review";
    distance?: number;
    similarity?: number;
  }>;
  candidates: Array<{
    photoId: string;
    deleteRecommended: boolean;
    qualityScore: number;
    metadata: {
      width: number;
      height: number;
      pixels: number;
      fileSize: number;
      takenAt: string | null;
      hasGps: boolean;
    };
  }>;
}

export interface SimilarPayload {
  groups: SimilarGroupPayload[];
  cache?: {
    hit: boolean;
    source: "memory" | "persistent" | "computed" | "none" | string;
  };
  stages: {
    phash: {
      exactDistance: number;
      reviewDistance: number;
    };
    clip: {
      status: string;
      similarity: number;
      reviewSimilarity: number;
    };
  };
}

export interface SimilarGroup {
  id: string;
  stage: "phash" | "clip" | "mixed";
  tier: "duplicate" | "similar" | "review";
  keepPhotoId: string;
  photos: Photo[];
  maxDistance: number | null;
  maxSimilarity: number | null;
  candidates: SimilarGroupPayload["candidates"];
}

export interface DeletePhotosPayload {
  excludedIds?: string[];
  deletedIds: string[];
  missingIds: string[];
  deletedFiles: number;
  deletedRecords: number;
}

export type ViewMode = "grid" | "list";
export type RatingFilter = "all" | "unrated" | "1" | "2" | "3" | "4" | "5";
export type StatusTone = "" | "ok" | "warn" | "error" | "busy";
export type SortMode = "score-desc" | "score-asc" | "name-asc" | "name-desc" | "mtime-desc" | "mtime-asc";
export type ToolTab = "browse" | "review" | "duplicates" | "export-enhance" | "stats" | "settings";
export type WorkspaceTab = ToolTab;
export type SimilarityScope = "current" | "library";

export interface ExportQueueState {
  ids: string[];
}

export interface AiRuntimeStatus {
  available: boolean;
  installed: boolean;
  installing: boolean;
  using: boolean;
  state: "idle" | "installing" | "installed" | "error" | string;
  message: string;
  detail: string;
  error: string;
  logPath: string;
  logTail: string[];
}

export interface RuntimeSettings {
  /** Python chosen in Settings; null means find one automatically. */
  pythonPath: string | null;
  /** AI_RUNTIME_PYTHON from the environment, which overrides pythonPath. */
  envPython: string | null;
  supportedRange: string;
  managedPython: { version: string; megabytes: number } | null;
  installedWith: { command: string; version: string } | null;
}

export type UpdateChannel = "stable" | "nightly";

export interface UpdateSettings {
  channel: UpdateChannel;
  version: string;
  commit: string | null;
  /** Built from a working tree with uncommitted changes. */
  dirty: boolean;
  builtAt: string | null;
  /** "0.3.1 (a1b2c3d, 2026-10-18 15:30 UTC)" */
  label: string;
  /** False in development builds, which never update themselves. */
  supported: boolean;
}

export interface PythonCheck {
  command: string | null;
  version: string | null;
  supported: boolean;
  message?: string;
}

export type PadDirections = { up: Record<string, number>; down: Record<string, number> };
export interface StylePad {
  tone: number;
  colour: number;
  base: Record<string, number>;
  vectors: { tone: PadDirections; colour: PadDirections };
}

export interface ExportEnhanceSettings {
  recipeVersion: 1 | 2;
  engineVersion: 1;
  rawProfileVersion: 1;
  gradient: LinearGradient | null;
  selectedColor: { center: number; range: number; hue: number; saturation: number; luminance: number } | null;
  brilliance: number;
  vibrance: number;
  blackPoint: number;
  dehaze: number;
  crop: { x: number; y: number; width: number; height: number; angle: number };
  auto: { base: Record<string, number>; target: Record<string, number>; strength: number } | null;
  pad: StylePad | null;
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  saturation: number;
  temperature: number;
  tint: number;
  aiDenoise: boolean;
  aiDenoiseStrength: "low" | "medium" | "high";
  upscale: boolean;
  upscaleScale: 2 | 4;
  sharpen: number;
  outputFormat: "jpeg" | "tiff";
  quality: number;
  resizeMaxEdge: number | null;
  photoStyle: PhotoStyle;
}

export interface LinearGradient {
  start: { x: number; y: number };
  end: { x: number; y: number };
  enabled: boolean;
  invert: boolean;
  feather: number;
  exposure: number;
  highlights: number;
  temperature: number;
}

// v2 ids come from server/editing_presets.json; "muted" and "dramatic" also name legacy (v1) styles.
export type PhotoStylePreset = string;

export interface PhotoStyle {
  preset: PhotoStylePreset;
  tone: number;
  colour: number;
  palette: number;
}

export interface StyleMaskPayload {
  photoId: string;
  width: number;
  height: number;
  dataUrl: string;
}

export interface ExportEnhanceJob {
  processingNotes?: string[];
  id: string;
  status: "queued" | "running" | "done" | "cancelled" | "error" | string;
  total: number;
  completed: number;
  failed: number;
  current: string | null;
  outputFolder: string;
  outputs: string[];
  failures: Array<{ photo_id?: string; photoId?: string; name: string; error: string }>;
  /** Photos not written yet; an interrupted or cancelled job can resume them. */
  pending?: number;
  resumable?: boolean;
  createdAt: number;
  updatedAt: number;
}

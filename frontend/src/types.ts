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
export type ToolTab = "browse" | "review" | "duplicates" | "export" | "stats";
export type WorkspaceTab = ToolTab;
export type SimilarityScope = "current" | "library";

export interface ExportQueueState {
  ids: string[];
}

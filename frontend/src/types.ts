export interface ApiPhoto {
  id: string;
  name: string;
  score: number | null;
  manualScore: number | null;
  path: string;
  url: string;
  folder: string;
  folderPath: string;
  relativePath: string;
  mtime: number;
  size: number;
  decision: "accepted" | "rejected" | null;
  status: "pending" | "processing" | "done" | "error";
  error?: string | null;
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

export interface LibraryPayload {
  folders: LibraryFolder[];
  photos: ApiPhoto[];
  summary: {
    pending: number;
    processing: number;
    done: number;
    error: number;
    scoreMode?: string;
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
  deletedIds: string[];
  missingIds: string[];
  deletedFiles: number;
  deletedRecords: number;
}

export type ViewMode = "grid" | "list";
export type DecisionFilter = "all" | "accepted" | "rejected";
export type StatusTone = "" | "ok" | "warn" | "error" | "busy";
export type SortMode = "score-desc" | "score-asc" | "name-asc" | "name-desc" | "mtime-desc" | "mtime-asc";

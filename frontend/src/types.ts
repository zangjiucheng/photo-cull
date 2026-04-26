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

export type ViewMode = "grid" | "list";
export type DecisionFilter = "all" | "accepted" | "rejected";
export type StatusTone = "" | "ok" | "warn" | "error" | "busy";
export type SortMode = "score-desc" | "score-asc" | "name-asc" | "name-desc" | "mtime-desc" | "mtime-asc";

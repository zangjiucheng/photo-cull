import type { ApiPhoto, DeletePhotosPayload, ExportEnhanceJob, ExportEnhanceSettings, LibraryPayload, PhotoWorkspace, SimilarPayload, SimilarityScope } from "./types";

async function parseError(res: Response, fallback: string): Promise<string> {
  const contentType = res.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? fallback;
  }
  const text = await res.text().catch(() => "");
  return text || fallback;
}

async function requestJson<T>(input: RequestInfo | URL, init: RequestInit | undefined, fallback: string): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    throw new Error(await parseError(res, fallback));
  }
  return (await res.json()) as T;
}

async function requestBlob(input: RequestInfo | URL, init: RequestInit | undefined, fallback: string): Promise<Blob> {
  const res = await fetch(input, init);
  if (!res.ok) {
    throw new Error(await parseError(res, fallback));
  }
  return res.blob();
}

export async function uploadPhotos(files: FileList): Promise<ApiPhoto[]> {
  const formData = new FormData();
  for (const file of Array.from(files)) {
    formData.append("files", file);
  }

  const data = await requestJson<ApiPhoto[]>("/api/photos/upload", {
    method: "POST",
    body: formData
  }, "Upload failed");

  if (!Array.isArray(data)) {
    throw new Error("Upload failed");
  }
  return data;
}

export async function fetchLibrary(): Promise<LibraryPayload> {
  return fetchWorkspaceLibrary(null);
}

export async function fetchWorkspaceLibrary(workspaceId: string | null): Promise<LibraryPayload> {
  const url = workspaceId ? `/api/library?workspace_id=${encodeURIComponent(workspaceId)}` : "/api/library";
  const data = await requestJson<LibraryPayload>(url, undefined, "Failed to load library");
  if (!data || !("folders" in data) || !("photos" in data)) {
    throw new Error("Failed to load library");
  }
  return data;
}

export async function refreshLibrary(workspaceId: string): Promise<LibraryPayload> {
  const data = await requestJson<LibraryPayload>(`/api/workspaces/${encodeURIComponent(workspaceId)}/refresh`, {
    method: "POST"
  }, "Failed to refresh library");
  if (!data || !("folders" in data) || !("photos" in data)) {
    throw new Error("Failed to refresh library");
  }
  return data;
}

export async function rescoreWorkspace(workspaceId: string): Promise<LibraryPayload> {
  const data = await requestJson<LibraryPayload>(`/api/workspaces/${encodeURIComponent(workspaceId)}/rescore`, {
    method: "POST"
  }, "Failed to refresh AI scores");
  if (!data || !("folders" in data) || !("photos" in data)) {
    throw new Error("Failed to refresh AI scores");
  }
  return data;
}

export async function saveExportQueue(workspaceId: string, photoIds: string[]): Promise<{ workspaceId: string; ids: string[] }> {
  return requestJson<{ workspaceId: string; ids: string[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/export-queue`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo_ids: Array.from(new Set(photoIds)) })
  }, "Failed to save export queue");
}

export async function fetchWorkspaces(): Promise<PhotoWorkspace[]> {
  const data = await requestJson<{ workspaces: PhotoWorkspace[] }>("/api/workspaces", undefined, "Failed to load workspaces");
  return Array.isArray(data.workspaces) ? data.workspaces : [];
}

export async function openWorkspace(rootPath: string): Promise<PhotoWorkspace> {
  const data = await requestJson<PhotoWorkspace>("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root_path: rootPath })
  }, "Failed to open folder");
  if (!data || !("id" in data)) {
    throw new Error("Failed to open folder");
  }
  return data;
}

export async function deleteWorkspace(workspaceId: string): Promise<{ deleted: boolean; workspaceId: string }> {
  return requestJson<{ deleted: boolean; workspaceId: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "DELETE"
  }, "Failed to delete workspace");
}

export async function restorePhotos(workspaceId: string, relativePaths?: string[]): Promise<{ restored: number; restoredPaths: string[] }> {
  return requestJson<{ restored: number; restoredPaths: string[] }>("/api/photos/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, relative_paths: relativePaths })
  }, "Failed to restore photos");
}

export async function exportPhotos(selectedIds: string[]): Promise<Blob> {
  const uniqueIds = Array.from(new Set(selectedIds));
  return requestBlob("/api/photos/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selected_ids: uniqueIds })
  }, "Export failed");
}

export async function createExportEnhanceJob(options: {
  selectedIds: string[];
  outputFolder: string;
  settings: ExportEnhanceSettings;
  settingsByPhoto?: Record<string, ExportEnhanceSettings>;
}): Promise<ExportEnhanceJob> {
  return requestJson<ExportEnhanceJob>("/api/export-enhance/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selected_ids: Array.from(new Set(options.selectedIds)),
      output_folder: options.outputFolder,
      settings: options.settings,
      settings_by_photo: options.settingsByPhoto ?? {}
    })
  }, "Failed to start export enhance");
}

export async function fetchExportEnhanceJob(jobId: string): Promise<ExportEnhanceJob> {
  return requestJson<ExportEnhanceJob>(`/api/export-enhance/jobs/${encodeURIComponent(jobId)}`, undefined, "Failed to load export enhance job");
}

export async function cancelExportEnhanceJob(jobId: string): Promise<ExportEnhanceJob> {
  return requestJson<ExportEnhanceJob>(`/api/export-enhance/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST"
  }, "Failed to cancel export enhance job");
}

export async function renderExportEnhancePreview(photoId: string, settings: ExportEnhanceSettings): Promise<Blob> {
  return requestBlob("/api/export-enhance/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo_id: photoId, settings })
  }, "Failed to render AI Enhance preview");
}

export async function updatePhotoDecision(photoId: string, decision: "accepted" | "rejected" | null): Promise<ApiPhoto> {
  const data = await requestJson<ApiPhoto>(`/api/photos/${photoId}/decision`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision })
  }, "Failed to update decision");

  if (!data || !("id" in data)) {
    throw new Error("Failed to update decision");
  }
  return data;
}

export async function updatePhotoRating(photoId: string, rating: number | null): Promise<ApiPhoto> {
  const data = await requestJson<ApiPhoto>(`/api/photos/${photoId}/rating`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating })
  }, "Failed to update rating");

  if (!data || !("id" in data)) {
    throw new Error("Failed to update rating");
  }
  return data;
}

export async function updatePhotoScore(photoId: string, manualScore: number | null): Promise<ApiPhoto> {
  const data = await requestJson<ApiPhoto>(`/api/photos/${photoId}/score`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manual_score: manualScore })
  }, "Failed to update score");

  if (!data || !("id" in data)) {
    throw new Error("Failed to update score");
  }
  return data;
}

export async function updatePhotoOrientation(photoId: string, orientationOverride: 0 | 90 | 180 | 270 | null): Promise<ApiPhoto> {
  const data = await requestJson<ApiPhoto>(`/api/photos/${photoId}/orientation`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orientation_override: orientationOverride })
  }, "Failed to update orientation");

  if (!data || !("id" in data)) {
    throw new Error("Failed to update orientation");
  }
  return data;
}

export async function findSimilarPhotos(options: {
  workspaceId: string;
  includeClip?: boolean;
  scope?: SimilarityScope;
  folderPath?: string;
  cacheOnly?: boolean;
}): Promise<SimilarPayload> {
  const params = new URLSearchParams();
  params.set("workspace_id", options.workspaceId);
  params.set("include_clip", options.includeClip === false ? "0" : "1");
  params.set("scope", options.scope ?? "library");
  if (options.folderPath !== undefined) {
    params.set("folder_path", options.folderPath);
  }
  if (options.cacheOnly) {
    params.set("cache_only", "1");
  }
  return requestJson<SimilarPayload>(`/api/photos/similar?${params.toString()}`, undefined, "Failed to find similar photos");
}

export async function deletePhotos(photoIds: string[]): Promise<DeletePhotosPayload> {
  return requestJson<DeletePhotosPayload>("/api/photos", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo_ids: photoIds })
  }, "Failed to delete photos");
}

export const apiInternals = { requestJson, requestBlob, parseError };

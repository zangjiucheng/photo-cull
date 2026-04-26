import type { ApiPhoto, DeletePhotosPayload, LibraryPayload, SimilarPayload } from "./types";

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
  const data = await requestJson<LibraryPayload>("/api/library", undefined, "Failed to load library");
  if (!data || !("folders" in data) || !("photos" in data)) {
    throw new Error("Failed to load library");
  }
  return data;
}

export async function refreshLibrary(): Promise<LibraryPayload> {
  const data = await requestJson<LibraryPayload>("/api/library/refresh", {
    method: "POST"
  }, "Failed to refresh library");
  if (!data || !("folders" in data) || !("photos" in data)) {
    throw new Error("Failed to refresh library");
  }
  return data;
}

export async function exportPhotos(selectedIds: string[]): Promise<Blob> {
  return requestBlob("/api/photos/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selected_ids: selectedIds })
  }, "Export failed");
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

export async function findSimilarPhotos(includeClip = true): Promise<SimilarPayload> {
  const flag = includeClip ? "1" : "0";
  return requestJson<SimilarPayload>(`/api/photos/similar?include_clip=${flag}`, undefined, "Failed to find similar photos");
}

export async function deletePhotos(photoIds: string[]): Promise<DeletePhotosPayload> {
  return requestJson<DeletePhotosPayload>("/api/photos", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo_ids: photoIds })
  }, "Failed to delete photos");
}

export const apiInternals = { requestJson, requestBlob, parseError };

import type { ApiPhoto, LibraryPayload } from "./types";

export async function uploadPhotos(files: FileList): Promise<ApiPhoto[]> {
  const formData = new FormData();
  for (const file of Array.from(files)) {
    formData.append("files", file);
  }

  const res = await fetch("/upload", {
    method: "POST",
    body: formData
  });

  const data = (await res.json()) as ApiPhoto[] | { error?: string };
  if (!res.ok || !Array.isArray(data)) {
    const message = Array.isArray(data) ? "Upload failed" : (data.error ?? "Upload failed");
    throw new Error(message);
  }

  return data;
}

export async function fetchLibrary(): Promise<LibraryPayload> {
  const res = await fetch("/library");
  const data = (await res.json()) as LibraryPayload | { error?: string };
  if (!res.ok || !data || !("folders" in data) || !("photos" in data)) {
    throw new Error("Failed to load library");
  }
  return data;
}

export async function refreshLibrary(): Promise<LibraryPayload> {
  const res = await fetch("/refresh", {
    method: "POST"
  });
  const data = (await res.json()) as LibraryPayload | { error?: string };
  if (!res.ok || !data || !("folders" in data) || !("photos" in data)) {
    throw new Error("Failed to refresh library");
  }
  return data;
}

export async function exportPhotos(selectedIds: string[]): Promise<Blob> {
  const res = await fetch("/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selected_ids: selectedIds })
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Export failed");
  }

  return res.blob();
}

export async function updatePhotoDecision(photoId: string, decision: "accepted" | "rejected" | null): Promise<ApiPhoto> {
  const res = await fetch("/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo_id: photoId, decision })
  });

  const data = (await res.json()) as ApiPhoto | { error?: string };
  if (!res.ok || !data || !("id" in data)) {
    const message = data && "error" in data ? (data.error ?? "Failed to update decision") : "Failed to update decision";
    throw new Error(message);
  }

  return data;
}

export async function updatePhotoScore(photoId: string, manualScore: number | null): Promise<ApiPhoto> {
  const res = await fetch("/score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo_id: photoId, manual_score: manualScore })
  });

  const data = (await res.json()) as ApiPhoto | { error?: string };
  if (!res.ok || !data || !("id" in data)) {
    const message = data && "error" in data ? (data.error ?? "Failed to update score") : "Failed to update score";
    throw new Error(message);
  }

  return data;
}

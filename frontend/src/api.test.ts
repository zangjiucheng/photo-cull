import { describe, expect, it, vi } from "vitest";
import { apiInternals, deletePhotos, findSimilarPhotos } from "./api";

describe("api helpers", () => {
  it("surfaces JSON error messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Bad request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(apiInternals.requestJson("/bad", undefined, "Fallback")).rejects.toThrow("Bad request");
    vi.unstubAllGlobals();
  });

  it("returns blobs for successful downloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("zip-data", { status: 200 })));

    const blob = await apiInternals.requestBlob("/download", undefined, "Download failed");
    expect(await blob.text()).toBe("zip-data");
    vi.unstubAllGlobals();
  });

  it("loads similar groups", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      groups: [{
        id: "g1",
        stage: "phash",
        tier: "duplicate",
        keepPhotoId: "a",
        photoIds: ["a", "b"],
        maxDistance: 2,
        maxSimilarity: null,
        matches: [],
        candidates: []
      }],
      stages: {
        phash: { exactDistance: 5, reviewDistance: 12 },
        clip: { status: "skipped", similarity: 0.92, reviewSimilarity: 0.85 }
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    const payload = await findSimilarPhotos({ scope: "current", folderPath: "shoot-a", includeClip: false });
    expect(payload.groups[0].photoIds).toEqual(["a", "b"]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/photos/similar?include_clip=0&scope=current&folder_path=shoot-a");
    vi.unstubAllGlobals();
  });

  it("deletes photos by id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      deletedIds: ["a"],
      missingIds: [],
      deletedFiles: 1,
      deletedRecords: 1
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await deletePhotos(["a"]);
    expect(payload.deletedRecords).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/photos", expect.objectContaining({ method: "DELETE" }));
    vi.unstubAllGlobals();
  });
});

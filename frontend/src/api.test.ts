import { describe, expect, it, vi } from "vitest";
import { apiInternals, createExportEnhanceJob, deletePhotos, deleteWorkspace, exportPhotos, findSimilarPhotos, openWorkspace, rescoreWorkspace, restorePhotos, saveExportEnhanceSettings, saveExportQueue } from "./api";

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

  it("deduplicates export photo ids", async () => {
    const fetchMock = vi.fn(async () => new Response("zip-data", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const blob = await exportPhotos(["a", "a", "b"]);
    expect(await blob.text()).toBe("zip-data");
    expect(fetchMock).toHaveBeenCalledWith("/api/photos/export", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ selected_ids: ["a", "b"] })
    }));
    vi.unstubAllGlobals();
  });

  it("saves persistent export queue ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      workspaceId: "ws1",
      ids: ["a", "b"]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await saveExportQueue("ws1", ["a", "a", "b"]);
    expect(payload.ids).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws1/export-queue", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ photo_ids: ["a", "b"] })
    }));
    vi.unstubAllGlobals();
  });

  it("saves persistent enhance edit settings", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      workspaceId: "ws1",
      settingsByPhoto: {
        a: {
          exposure: 0,
          contrast: 0,
          highlights: 0,
          shadows: 0,
          saturation: 0,
          temperature: 0,
          tint: 0,
          aiDenoise: true,
          aiDenoiseStrength: "medium",
          upscale: false,
          upscaleScale: 2,
          sharpen: 0,
          outputFormat: "jpeg",
          quality: 92,
          resizeMaxEdge: null,
          photoStyle: { preset: "warm", tone: 10, colour: 2, palette: 80 }
        }
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await saveExportEnhanceSettings("ws1", {
      a: {
        exposure: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        saturation: 0,
        temperature: 0,
        tint: 0,
        aiDenoise: true,
        aiDenoiseStrength: "medium",
        upscale: false,
        upscaleScale: 2,
        sharpen: 0,
        outputFormat: "jpeg",
        quality: 92,
        resizeMaxEdge: null,
        photoStyle: { preset: "warm", tone: 10, colour: 2, palette: 80 }
      }
    });

    expect(payload.settingsByPhoto.a.photoStyle.preset).toBe("warm");
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws1/export-enhance-settings", expect.objectContaining({
      method: "PUT",
      body: expect.stringContaining("\"settings_by_photo\"")
    }));
    vi.unstubAllGlobals();
  });

  it("starts an export enhance job", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "job1",
      status: "queued",
      total: 2,
      completed: 0,
      failed: 0,
      current: null,
      outputFolder: "/tmp/out",
      outputs: [],
      failures: [],
      createdAt: 1,
      updatedAt: 1
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const job = await createExportEnhanceJob({
      selectedIds: ["a", "a", "b"],
      outputFolder: "/tmp/out",
      settings: {
        exposure: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        saturation: 0,
        temperature: 0,
        tint: 0,
        aiDenoise: false,
        aiDenoiseStrength: "medium",
        upscale: false,
        upscaleScale: 2,
        sharpen: 0,
        outputFormat: "jpeg",
        quality: 92,
        resizeMaxEdge: null,
        photoStyle: {
          preset: "standard",
          tone: 0,
          colour: 0,
          palette: 100
        }
      }
    });
    expect(job.id).toBe("job1");
    expect(fetchMock).toHaveBeenCalledWith("/api/export-enhance/jobs", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("\"selected_ids\":[\"a\",\"b\"]")
    }));
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

    const payload = await findSimilarPhotos({ workspaceId: "ws1", scope: "current", folderPath: "shoot-a", includeClip: false });
    expect(payload.groups[0].photoIds).toEqual(["a", "b"]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/photos/similar?workspace_id=ws1&include_clip=0&scope=current&folder_path=shoot-a");
    vi.unstubAllGlobals();
  });

  it("requests cached similar groups without computing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      groups: [],
      cache: { hit: false, source: "none" },
      stages: {
        phash: { exactDistance: 5, reviewDistance: 12 },
        clip: { status: "cached:miss", similarity: 0.92, reviewSimilarity: 0.85 }
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    const payload = await findSimilarPhotos({ workspaceId: "ws1", scope: "current", folderPath: "shoot-a", cacheOnly: true });
    expect(payload.cache?.hit).toBe(false);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/photos/similar?workspace_id=ws1&include_clip=1&scope=current&folder_path=shoot-a&cache_only=1");
    vi.unstubAllGlobals();
  });

  it("deletes photos by id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      deletedIds: ["a"],
      missingIds: [],
      deletedFiles: 0,
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

  it("opens a folder workspace", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "ws1",
      name: "Shoot",
      rootPath: "/photos/Shoot",
      createdAt: 1,
      updatedAt: 1,
      lastScannedAt: 1
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const workspace = await openWorkspace("/photos/Shoot");
    expect(workspace.id).toBe("ws1");
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ root_path: "/photos/Shoot" })
    }));
    vi.unstubAllGlobals();
  });

  it("deletes a workspace by id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      deleted: true,
      workspaceId: "ws1"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteWorkspace("ws1");
    expect(result.deleted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws1", expect.objectContaining({ method: "DELETE" }));
    vi.unstubAllGlobals();
  });

  it("restores removed photos for a workspace", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      restored: 1,
      restoredPaths: ["a.jpg"]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const restored = await restorePhotos("ws1");
    expect(restored.restored).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/photos/restore", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });

  it("requests a full workspace AI rescore", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      activeWorkspace: null,
      workspaces: [],
      folders: [],
      photos: [],
      summary: { pending: 0, processing: 0, done: 0, error: 0 }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await rescoreWorkspace("ws1");
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws1/rescore", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });
});

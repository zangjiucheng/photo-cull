import { describe, expect, it, vi } from "vitest";
import { apiInternals } from "./api";

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
});

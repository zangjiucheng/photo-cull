import { describe, expect, it } from "vitest";
import { normalizeScores } from "./core";
import type { ApiPhoto } from "./types";

function photo(overrides: Partial<ApiPhoto>): ApiPhoto {
  return {
    id: "id",
    name: "IMG_0001.jpg",
    score: 10,
    manualScore: null,
    path: "/tmp/IMG_0001.jpg",
    url: "/api/photos/id/image",
    folder: "Root",
    folderPath: "",
    relativePath: "IMG_0001.jpg",
    mtime: 1,
    size: 100,
    decision: null,
    status: "done",
    error: null,
    ...overrides
  };
}

describe("normalizeScores", () => {
  it("normalizes raw scores onto a 0-100 range", () => {
    const normalized = normalizeScores([
      photo({ id: "low", score: 10 }),
      photo({ id: "high", score: 20 })
    ]);

    expect(normalized.find((item) => item.id === "low")?.aiScore).toBe(0);
    expect(normalized.find((item) => item.id === "high")?.aiScore).toBe(100);
  });

  it("prefers manual score overrides", () => {
    const normalized = normalizeScores([photo({ manualScore: 73, score: 1 })]);
    expect(normalized[0].aiScore).toBe(73);
  });
});

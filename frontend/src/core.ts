import type { ApiPhoto, Photo } from "./types";

const AUTO_REJECT_SCORE = 35;

function deriveBurstKey(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  // Only trim trailing numbers when they look like burst/counter suffixes,
  // such as IMG_1023 or DSC-0007. This avoids over-grouping names like "trip2".
  const key = stem.replace(/([_-])\d{2,}$/i, "").toLowerCase();
  return key || filename.toLowerCase();
}

export function normalizeScores(items: ApiPhoto[]): Photo[] {
  if (!items.length) {
    return [];
  }

  const scoredItems = items.filter((p) => p.score !== null);
  const rawScores = scoredItems.map((p) => Number(p.score));
  const hasScored = rawScores.length > 0;
  const minRaw = hasScored ? Math.min(...rawScores) : 0;
  const maxRaw = hasScored ? Math.max(...rawScores) : 0;
  const span = maxRaw - minRaw;

  return items.map((p) => {
    const normalized = p.manualScore !== null && p.manualScore !== undefined
      ? Math.max(0, Math.min(100, Math.round(Number(p.manualScore))))
      : p.score === null || !hasScored
        ? 0
        : span === 0
          ? 80
          : Math.round(((Number(p.score) - minRaw) / span) * 100);

    const burstKey = deriveBurstKey(p.name);
    return {
      ...p,
      aiScore: normalized,
      burstKey,
      rejected: p.status === "done" && normalized < AUTO_REJECT_SCORE
    };
  });
}

export function groupedBest(items: Photo[]): Photo[] {
  const map = new Map<string, Photo>();
  for (const p of items) {
    const current = map.get(p.burstKey);
    if (!current || p.aiScore > current.aiScore) {
      map.set(p.burstKey, p);
    }
  }
  return [...map.values()];
}

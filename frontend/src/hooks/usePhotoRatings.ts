import { useEffect, useState } from "react";
import { updatePhotoRating } from "../api";
import type { Photo, StatusTone } from "../types";

export function usePhotoRatings(photos: Photo[], updateStatus: (text: string, tone?: StatusTone) => void) {
  const [ratings, setRatings] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    setRatings(new Map(photos.filter((photo) => photo.rating !== null).map((photo) => [photo.id, Number(photo.rating)])));
  }, [photos]);

  function setRatingLocal(id: string, rating: number | null) {
    setRatings((prev) => {
      const next = new Map(prev);
      if (rating === null) {
        next.delete(id);
      } else {
        next.set(id, rating);
      }
      return next;
    });
  }

  async function saveRating(id: string, rating: number | null) {
    const previous = ratings.get(id) ?? null;
    setRatingLocal(id, rating);
    try {
      await updatePhotoRating(id, rating);
    } catch (err) {
      setRatingLocal(id, previous);
      updateStatus(err instanceof Error ? err.message : "Failed to save rating", "error");
    }
  }

  function ratePhoto(id: string, rating: number) {
    const next = ratings.get(id) === rating ? null : rating;
    void saveRating(id, next);
  }

  return {
    ratings,
    setRatings,
    ratePhoto,
    saveRating
  };
}

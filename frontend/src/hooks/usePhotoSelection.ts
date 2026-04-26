import { useEffect, useState } from "react";
import { updatePhotoDecision } from "../api";
import type { Photo, StatusTone } from "../types";

export function usePhotoSelection(photos: Photo[], updateStatus: (text: string, tone?: StatusTone) => void) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelectedIds(new Set(photos.filter((photo) => photo.decision === "accepted").map((photo) => photo.id)));
    setRejectedIds(new Set(photos.filter((photo) => photo.decision === "rejected").map((photo) => photo.id)));
  }, [photos]);

  function setDecisionLocal(id: string, decision: "accepted" | "rejected" | null) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (decision === "accepted") {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    setRejectedIds((prev) => {
      const next = new Set(prev);
      if (decision === "rejected") {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  async function saveDecision(id: string, decision: "accepted" | "rejected" | null) {
    const previousAccepted = selectedIds.has(id);
    const previousRejected = rejectedIds.has(id);
    setDecisionLocal(id, decision);
    try {
      await updatePhotoDecision(id, decision);
    } catch (err) {
      if (previousAccepted) {
        setDecisionLocal(id, "accepted");
      } else if (previousRejected) {
        setDecisionLocal(id, "rejected");
      } else {
        setDecisionLocal(id, null);
      }
      updateStatus(err instanceof Error ? err.message : "Failed to save decision", "error");
    }
  }

  function toggleAccept(id: string) {
    const next = selectedIds.has(id) ? null : "accepted";
    void saveDecision(id, next);
  }

  function toggleReject(id: string) {
    const next = rejectedIds.has(id) ? null : "rejected";
    void saveDecision(id, next);
  }

  return {
    selectedIds,
    rejectedIds,
    setSelectedIds,
    setRejectedIds,
    toggleAccept,
    toggleReject
  };
}

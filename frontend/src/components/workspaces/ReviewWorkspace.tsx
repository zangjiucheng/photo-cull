import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { Photo } from "../../types";
import { Button } from "../ui/button";
import { PhotoGrid } from "../library/PhotoGrid";

interface ReviewWorkspaceProps {
  activePhoto: Photo | null;
  folderPhotos: Photo[];
  ratings: Map<string, number>;
  exportQueueIds: Set<string>;
  onSelectPhoto: (id: string) => void;
  onRatePhoto: (id: string, rating: number) => void;
  onAutoRateByScore: () => void;
  onToggleExportQueue: (id: string) => void;
}

export function ReviewWorkspace({ activePhoto, folderPhotos, ratings, exportQueueIds, onSelectPhoto, onRatePhoto, onAutoRateByScore, onToggleExportQueue }: ReviewWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const reviewStageRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [previewHeight, setPreviewHeight] = useState(420);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const rating = activePhoto ? ratings.get(activePhoto.id) ?? activePhoto.rating ?? 0 : 0;

  const getClampedPreviewHeight = useCallback((height: number) => {
    const workspace = workspaceRef.current;
    const reviewStage = reviewStageRef.current;
    if (!workspace || !reviewStage) return Math.max(220, height);

    const stageTop = reviewStage.getBoundingClientRect().top;
    const workspaceBottom = workspace.getBoundingClientRect().bottom;
    const minPreviewHeight = 220;
    const minGalleryHeight = 180;
    const resizeHandleHeight = 10;
    const maxPreviewHeight = Math.max(minPreviewHeight, workspaceBottom - stageTop - minGalleryHeight - resizeHandleHeight);

    return Math.min(Math.max(height, minPreviewHeight), maxPreviewHeight);
  }, []);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);
    resizeCleanupRef.current?.();
    document.body.classList.add("review-resizing");

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const reviewStage = reviewStageRef.current;
      if (!reviewStage) return;
      setPreviewHeight(getClampedPreviewHeight(moveEvent.clientY - reviewStage.getBoundingClientRect().top));
    };

    const stopResizing = () => {
      document.body.classList.remove("review-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      window.removeEventListener("blur", stopResizing);
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = stopResizing;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    window.addEventListener("blur", stopResizing);
  }, [getClampedPreviewHeight]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setPreviewHeight((height) => getClampedPreviewHeight(height + (event.key === "ArrowUp" ? -32 : 32)));
  }, [getClampedPreviewHeight]);

  const setClampedPreviewZoom = useCallback((nextZoom: number | ((zoom: number) => number)) => {
    setPreviewZoom((zoom) => {
      const resolvedZoom = typeof nextZoom === "function" ? nextZoom(zoom) : nextZoom;
      return Math.min(Math.max(resolvedZoom, 25), 300);
    });
  }, []);

  const handlePreviewWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || event.metaKey) return;

    event.preventDefault();
    const zoomDelta = event.deltaY > 0 ? -10 : 10;
    setClampedPreviewZoom((zoom) => zoom + zoomDelta);
  }, [setClampedPreviewZoom]);

  const getGalleryColumnCount = useCallback(() => {
    const gallery = workspaceRef.current?.querySelector(".bridge-gallery");
    const cards = gallery ? Array.from(gallery.querySelectorAll<HTMLElement>(".photo-card")) : [];
    if (!cards.length) return 1;

    const firstTop = cards[0].getBoundingClientRect().top;
    const firstRowCount = cards.filter((card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 2).length;
    return Math.max(1, firstRowCount);
  }, []);

  useEffect(() => {
    if (!activePhoto) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;

      if (event.metaKey && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        setClampedPreviewZoom((zoom) => zoom + 25);
        return;
      }

      if (event.metaKey && (event.key === "-" || event.key === "_")) {
        event.preventDefault();
        setClampedPreviewZoom((zoom) => zoom - 25);
        return;
      }

      if (event.metaKey && event.key === "0") {
        event.preventDefault();
        setClampedPreviewZoom(100);
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

      const key = event.key.toLowerCase();
      if (key === "q") {
        event.preventDefault();
        if (!event.repeat) {
          onToggleExportQueue(activePhoto.id);
        }
        return;
      }

      if (!["h", "j", "k", "l"].includes(key)) return;

      const currentIndex = folderPhotos.findIndex((photo) => photo.id === activePhoto.id);
      if (currentIndex < 0) return;

      const columnCount = getGalleryColumnCount();
      const offsetByKey: Record<string, number> = {
        h: -1,
        j: columnCount,
        k: -columnCount,
        l: 1
      };
      const nextIndex = Math.min(Math.max(currentIndex + offsetByKey[key], 0), folderPhotos.length - 1);
      if (nextIndex === currentIndex) return;

      event.preventDefault();
      onSelectPhoto(folderPhotos[nextIndex].id);
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activePhoto, folderPhotos, getGalleryColumnCount, onSelectPhoto, onToggleExportQueue, setClampedPreviewZoom]);

  useEffect(() => {
    const activeCard = workspaceRef.current?.querySelector(".bridge-gallery .photo-card.active");
    if (activeCard) {
      activeCard.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activePhoto?.id]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;

    const updatePreviewSize = () => {
      setPreviewSize({
        width: preview.clientWidth,
        height: preview.clientHeight
      });
    };

    updatePreviewSize();
    const observer = new ResizeObserver(updatePreviewSize);
    observer.observe(preview);

    return () => observer.disconnect();
  }, [activePhoto?.id]);

  useEffect(() => {
    setImageSize({ width: 0, height: 0 });
  }, [activePhoto?.id]);

  useEffect(() => {
    return () => resizeCleanupRef.current?.();
  }, []);

  const previewImageStyle = useMemo(() => {
    if (!imageSize.width || !imageSize.height || !previewSize.width || !previewSize.height) {
      return undefined;
    }

    const previewPadding = 24;
    const availableWidth = Math.max(1, previewSize.width - previewPadding);
    const availableHeight = Math.max(1, previewSize.height - previewPadding);
    const fitScale = Math.min(availableWidth / imageSize.width, availableHeight / imageSize.height);
    const zoomScale = fitScale * (previewZoom / 100);

    return {
      width: `${Math.max(1, imageSize.width * zoomScale)}px`,
      height: `${Math.max(1, imageSize.height * zoomScale)}px`
    } as CSSProperties;
  }, [imageSize.height, imageSize.width, previewSize.height, previewSize.width, previewZoom]);

  return (
    <div
      className="workspace-panel review-workspace"
      ref={workspaceRef}
      style={{
        "--review-preview-height": `${previewHeight}px`
      } as CSSProperties}
    >
      <div className="workspace-head">
        <div>
          <span className="panel-kicker">Review</span>
          <h2>{activePhoto ? activePhoto.name : "No Photo Selected"}</h2>
        </div>
        <Button variant="outline" onClick={onAutoRateByScore}>AI Rate Folder</Button>
      </div>
      <div className="review-stage" ref={reviewStageRef}>
        {activePhoto ? (
          <>
            <div
              className={`review-preview ${previewZoom > 100 ? "zoomed" : ""}`.trim()}
              ref={previewRef}
              onWheel={handlePreviewWheel}
            >
              <img
                src={activePhoto.url}
                alt={activePhoto.name}
                style={previewImageStyle}
                onLoad={(event) => {
                  setImageSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight
                  });
                }}
              />
              <div className="review-zoom-indicator" aria-live="polite">{previewZoom}%</div>
            </div>
            <div className="review-controls">
              <div className="star-rating review-stars" aria-label={`Rating ${rating || "unrated"} out of 5`}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <button key={star} type="button" className={`star-btn ${rating >= star ? "filled" : ""}`.trim()} onClick={() => onRatePhoto(activePhoto.id, star)}>★</button>
                ))}
              </div>
              <Button variant={exportQueueIds.has(activePhoto.id) ? "secondary" : "outline"} onClick={() => onToggleExportQueue(activePhoto.id)}>
                {exportQueueIds.has(activePhoto.id) ? "Queued for Export" : "Add to Export Queue"}
              </Button>
            </div>
          </>
        ) : <div className="empty-gallery">Select a photo to begin review.</div>}
      </div>
      <div
        className="review-resize-handle"
        role="separator"
        aria-label="Resize review preview"
        aria-orientation="horizontal"
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
      />
      <PhotoGrid
        photos={folderPhotos}
        ratings={ratings}
        activePhotoId={activePhoto?.id ?? null}
        viewMode="grid"
        exportQueueIds={exportQueueIds}
        onSelectPhoto={onSelectPhoto}
        onRatePhoto={onRatePhoto}
        onToggleExportQueue={onToggleExportQueue}
      />
    </div>
  );
}

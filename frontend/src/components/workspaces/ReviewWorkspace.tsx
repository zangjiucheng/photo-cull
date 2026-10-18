import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { shortcutRegistry } from "../../shortcuts/registry";
import type { ShortcutHandlers } from "../../shortcuts/types";
import { useShortcuts } from "../../shortcuts/useShortcuts";
import type { Photo } from "../../types";
import { Button } from "../ui/button";
import { PhotoGrid } from "../library/PhotoGrid";

interface ReviewWorkspaceProps {
  activePhoto: Photo | null;
  folderPhotos: Photo[];
  ratings: Map<string, number>;
  exportQueueIds: Set<string>;
  shortcutsDisabled?: boolean;
  onSelectPhoto: (id: string) => void;
  onRatePhoto: (id: string, rating: number) => void;
  onAutoRateByScore: () => void;
  onToggleExportQueue: (id: string) => void;
}

export function ReviewWorkspace({ activePhoto, folderPhotos, ratings, exportQueueIds, shortcutsDisabled = false, onSelectPhoto, onRatePhoto, onAutoRateByScore, onToggleExportQueue }: ReviewWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const reviewStageRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [previewHeight, setPreviewHeight] = useState(420);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const rating = activePhoto ? ratings.get(activePhoto.id) ?? activePhoto.rating ?? 0 : 0;
  const isQueued = activePhoto ? exportQueueIds.has(activePhoto.id) : false;
  const activeIndex = activePhoto ? folderPhotos.findIndex((photo) => photo.id === activePhoto.id) : -1;

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

  // Start with the photo as large as possible, leaving the minimum filmstrip height below it.
  useLayoutEffect(() => {
    setPreviewHeight(getClampedPreviewHeight(Number.MAX_SAFE_INTEGER));
  }, [getClampedPreviewHeight]);

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

  const reviewShortcutHandlers = useMemo<ShortcutHandlers>(() => ({
    "review.toggleQueue": () => {
      if (!activePhoto) {
        return false;
      }
      onToggleExportQueue(activePhoto.id);
    },
    "review.zoomIn": () => {
      setClampedPreviewZoom((zoom) => zoom + 25);
    },
    "review.zoomOut": () => {
      setClampedPreviewZoom((zoom) => zoom - 25);
    },
    "review.resetZoom": () => {
      setClampedPreviewZoom(100);
    }
  }), [activePhoto, onToggleExportQueue, setClampedPreviewZoom]);
  const reviewShortcutScopes = useMemo(() => ["review" as const], []);

  useShortcuts({
    shortcuts: shortcutRegistry,
    handlers: reviewShortcutHandlers,
    activeScopes: reviewShortcutScopes,
    disabled: shortcutsDisabled || !activePhoto
  });

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
      <div className="review-head">
        <h2 className="review-title" title={activePhoto?.name}>{activePhoto ? activePhoto.name : "No Photo Selected"}</h2>
        {activeIndex >= 0 ? <span className="review-position">{activeIndex + 1} / {folderPhotos.length}</span> : null}
        <Button variant="ghost" size="sm" className="review-head-action" onClick={onAutoRateByScore}>AI Rate Folder</Button>
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
                  <button
                    key={star}
                    type="button"
                    className={`star-btn ${rating >= star ? "filled" : ""}`.trim()}
                    onClick={() => onRatePhoto(activePhoto.id, star)}
                    aria-label={`Set ${star} star${star === 1 ? "" : "s"}`}
                  >
                    ★
                  </button>
                ))}
              </div>
              <Button
                variant={isQueued ? "secondary" : "outline"}
                size="sm"
                className={`review-queue-toggle ${isQueued ? "queued" : ""}`.trim()}
                aria-pressed={isQueued}
                onClick={() => onToggleExportQueue(activePhoto.id)}
              >
                <span className="review-queue-dot" aria-hidden="true" />
                {isQueued ? "Queued for Export" : "Add to Export Queue"}
              </Button>
              <div className="review-hints" aria-hidden="true">
                <span><kbd>H</kbd><kbd>L</kbd> prev / next</span>
                <span><kbd>Q</kbd> queue</span>
                <span><kbd>Space</kbd> enlarge</span>
                <span><kbd>⌘</kbd><kbd>+</kbd><kbd>−</kbd> zoom</span>
              </div>
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

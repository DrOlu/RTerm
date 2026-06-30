import React from "react";
import {
  clampPreviewValue,
  resolveAnchoredPreviewScrollOffsetFromCoordinate,
  resolvePreviewWheelZoomMultiplier,
  shouldHandlePreviewWheelZoom,
} from "./previewInteractions";

interface ImagePreviewProps {
  src: string;
  alt: string;
  errorMessage: string;
}

interface Size {
  width: number;
  height: number;
}

interface PendingZoomAnchor {
  localX: number;
  localY: number;
  contentCoordinateX: number;
  contentCoordinateY: number;
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
}

const PREVIEW_PADDING = 16;
const MIN_USER_SCALE = 0.25;
const MAX_DISPLAY_SCALE = 8;
const MIN_DISPLAY_SCALE = 0.05;

const useElementSize = (ref: React.RefObject<HTMLElement>): Size => {
  const [size, setSize] = React.useState<Size>({ width: 0, height: 0 });

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateSize = (): void => {
      setSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };
    updateSize();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
};

const hasScrollableOverflow = (element: HTMLElement): boolean =>
  element.scrollWidth > element.clientWidth + 1 ||
  element.scrollHeight > element.clientHeight + 1;

export const ImagePreview: React.FC<ImagePreviewProps> = ({
  src,
  alt,
  errorMessage,
}) => {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const pendingZoomAnchorRef = React.useRef<PendingZoomAnchor | null>(null);
  const panStateRef = React.useRef<PanState | null>(null);
  const [naturalSize, setNaturalSize] = React.useState<Size | null>(null);
  const [imageError, setImageError] = React.useState(false);
  const [userScale, setUserScale] = React.useState(1);
  const [isPanning, setIsPanning] = React.useState(false);
  const viewportSize = useElementSize(viewportRef);

  React.useEffect(() => {
    setNaturalSize(null);
    setImageError(false);
    setUserScale(1);
    setIsPanning(false);
    pendingZoomAnchorRef.current = null;
    panStateRef.current = null;
  }, [src]);

  const usableWidth = Math.max(1, viewportSize.width - PREVIEW_PADDING * 2);
  const usableHeight = Math.max(1, viewportSize.height - PREVIEW_PADDING * 2);
  const fitScale = naturalSize
    ? clampPreviewValue(
        Math.min(
          usableWidth / naturalSize.width,
          usableHeight / naturalSize.height,
          1,
        ),
        MIN_DISPLAY_SCALE,
        MAX_DISPLAY_SCALE,
      )
    : 1;
  const maxUserScale =
    fitScale > 0 ? MAX_DISPLAY_SCALE / fitScale : MAX_DISPLAY_SCALE;
  const safeUserScale = clampPreviewValue(
    userScale,
    MIN_USER_SCALE,
    maxUserScale,
  );
  const displayScale = naturalSize
    ? clampPreviewValue(
        fitScale * safeUserScale,
        MIN_DISPLAY_SCALE,
        MAX_DISPLAY_SCALE,
      )
    : 1;
  const contentWidth = naturalSize
    ? Math.max(1, naturalSize.width * displayScale)
    : 0;
  const contentHeight = naturalSize
    ? Math.max(1, naturalSize.height * displayScale)
    : 0;
  const stageWidth = Math.max(
    viewportSize.width,
    contentWidth + PREVIEW_PADDING * 2,
  );
  const stageHeight = Math.max(
    viewportSize.height,
    contentHeight + PREVIEW_PADDING * 2,
  );
  const contentOffsetLeft = Math.max(
    PREVIEW_PADDING,
    (stageWidth - contentWidth) / 2,
  );
  const contentOffsetTop = Math.max(
    PREVIEW_PADDING,
    (stageHeight - contentHeight) / 2,
  );
  const canPan =
    contentWidth > viewportSize.width + 1 ||
    contentHeight > viewportSize.height + 1;

  const metricsRef = React.useRef({
    contentOffsetLeft,
    contentOffsetTop,
    displayScale,
    fitScale,
    maxUserScale,
    userScale: safeUserScale,
  });

  React.useEffect(() => {
    metricsRef.current = {
      contentOffsetLeft,
      contentOffsetTop,
      displayScale,
      fitScale,
      maxUserScale,
      userScale: safeUserScale,
    };
  }, [
    contentOffsetLeft,
    contentOffsetTop,
    displayScale,
    fitScale,
    maxUserScale,
    safeUserScale,
  ]);

  React.useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const viewport = viewportRef.current;
    if (!anchor || !viewport) return;
    pendingZoomAnchorRef.current = null;

    viewport.scrollLeft = resolveAnchoredPreviewScrollOffsetFromCoordinate({
      contentCoordinate: anchor.contentCoordinateX,
      pointerOffset: anchor.localX,
      newScale: displayScale,
      contentOffset: contentOffsetLeft,
      maxScrollOffset: viewport.scrollWidth - viewport.clientWidth,
    });
    viewport.scrollTop = resolveAnchoredPreviewScrollOffsetFromCoordinate({
      contentCoordinate: anchor.contentCoordinateY,
      pointerOffset: anchor.localY,
      newScale: displayScale,
      contentOffset: contentOffsetTop,
      maxScrollOffset: viewport.scrollHeight - viewport.clientHeight,
    });
  }, [contentOffsetLeft, contentOffsetTop, displayScale]);

  const queueZoomAnchor = React.useCallback(
    (clientX: number, clientY: number): void => {
      const viewport = viewportRef.current;
      const natural = naturalSize;
      if (!viewport || !natural) return;

      const rect = viewport.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const metrics = metricsRef.current;
      pendingZoomAnchorRef.current = {
        localX,
        localY,
        contentCoordinateX:
          (viewport.scrollLeft + localX - metrics.contentOffsetLeft) /
          metrics.displayScale,
        contentCoordinateY:
          (viewport.scrollTop + localY - metrics.contentOffsetTop) /
          metrics.displayScale,
      };
    },
    [naturalSize],
  );

  const handleWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>): void => {
      if (!naturalSize || !shouldHandlePreviewWheelZoom(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const metrics = metricsRef.current;
      const multiplier = resolvePreviewWheelZoomMultiplier(
        event.deltaY,
        event.deltaMode,
      );
      const nextUserScale = clampPreviewValue(
        metrics.userScale * multiplier,
        MIN_USER_SCALE,
        metrics.maxUserScale,
      );
      if (Math.abs(nextUserScale - metrics.userScale) < 0.0001) {
        return;
      }

      queueZoomAnchor(event.clientX, event.clientY);
      setUserScale(nextUserScale);
    },
    [naturalSize, queueZoomAnchor],
  );

  const handleDoubleClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (!naturalSize) return;
      event.preventDefault();

      const metrics = metricsRef.current;
      const zoomInUserScale =
        metrics.fitScale >= 0.98 ? 2 : Math.max(1, 1 / metrics.fitScale);
      const nextUserScale =
        metrics.userScale > 1.05
          ? 1
          : clampPreviewValue(
              zoomInUserScale,
              MIN_USER_SCALE,
              metrics.maxUserScale,
            );

      if (Math.abs(nextUserScale - metrics.userScale) < 0.0001) {
        return;
      }
      queueZoomAnchor(event.clientX, event.clientY);
      setUserScale(nextUserScale);
    },
    [naturalSize, queueZoomAnchor],
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const viewport = viewportRef.current;
      if (!viewport || event.button !== 0 || !hasScrollableOverflow(viewport)) {
        return;
      }
      panStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      };
      viewport.setPointerCapture(event.pointerId);
      setIsPanning(true);
      event.preventDefault();
    },
    [],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const viewport = viewportRef.current;
      const panState = panStateRef.current;
      if (!viewport || !panState || panState.pointerId !== event.pointerId) {
        return;
      }
      viewport.scrollLeft =
        panState.scrollLeft - (event.clientX - panState.startX);
      viewport.scrollTop =
        panState.scrollTop - (event.clientY - panState.startY);
      event.preventDefault();
    },
    [],
  );

  const finishPan = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const viewport = viewportRef.current;
      const panState = panStateRef.current;
      if (!viewport || !panState || panState.pointerId !== event.pointerId) {
        return;
      }
      panStateRef.current = null;
      if (viewport.hasPointerCapture(event.pointerId)) {
        viewport.releasePointerCapture(event.pointerId);
      }
      setIsPanning(false);
    },
    [],
  );

  return (
    <div
      ref={viewportRef}
      className={`file-editor-image-preview${canPan ? " can-pan" : ""}${isPanning ? " is-panning" : ""}`}
      data-testid="image-preview"
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPan}
      onPointerCancel={finishPan}
      onPointerLeave={finishPan}
    >
      {imageError ? (
        <div className="file-editor-error">{errorMessage}</div>
      ) : (
        <div
          className="file-editor-image-stage"
          style={{
            width: `${stageWidth}px`,
            height: `${stageHeight}px`,
          }}
        >
          <img
            className={`file-editor-image${naturalSize ? "" : " is-loading"}`}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget;
              setImageError(false);
              setNaturalSize({
                width: Math.max(1, image.naturalWidth || image.width || 1),
                height: Math.max(1, image.naturalHeight || image.height || 1),
              });
            }}
            onError={() => {
              setNaturalSize(null);
              setImageError(true);
              setIsPanning(false);
              pendingZoomAnchorRef.current = null;
              panStateRef.current = null;
            }}
            style={
              naturalSize
                ? {
                    width: `${contentWidth}px`,
                    height: `${contentHeight}px`,
                    left: `${contentOffsetLeft}px`,
                    top: `${contentOffsetTop}px`,
                  }
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
};

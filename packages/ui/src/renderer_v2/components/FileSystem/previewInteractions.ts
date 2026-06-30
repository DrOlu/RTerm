export const PREVIEW_WHEEL_DELTA_PIXEL = 0;
export const PREVIEW_WHEEL_DELTA_LINE = 1;
export const PREVIEW_WHEEL_DELTA_PAGE = 2;

const LINE_DELTA_PIXELS = 16;
const PAGE_DELTA_PIXELS = 800;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

export const clampPreviewValue = (
  value: number,
  min: number,
  max: number,
): number => Math.max(min, Math.min(max, value));

export const shouldHandlePreviewWheelZoom = (input: {
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean => input.ctrlKey === true || input.metaKey === true;

export const normalizePreviewWheelDelta = (
  deltaY: number,
  deltaMode: number,
): number => {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return 0;
  }
  if (deltaMode === PREVIEW_WHEEL_DELTA_LINE) {
    return deltaY * LINE_DELTA_PIXELS;
  }
  if (deltaMode === PREVIEW_WHEEL_DELTA_PAGE) {
    return deltaY * PAGE_DELTA_PIXELS;
  }
  return deltaY;
};

export const resolvePreviewWheelZoomMultiplier = (
  deltaY: number,
  deltaMode: number,
): number => {
  const normalizedDelta = normalizePreviewWheelDelta(deltaY, deltaMode);
  if (normalizedDelta === 0) {
    return 1;
  }
  return clampPreviewValue(
    Math.exp(-normalizedDelta * WHEEL_ZOOM_SENSITIVITY),
    0.5,
    2,
  );
};

export const resolveAnchoredPreviewScrollOffset = (input: {
  scrollOffset: number;
  pointerOffset: number;
  oldScale: number;
  newScale: number;
  contentOffset?: number;
  maxScrollOffset?: number;
}): number => {
  const oldScale =
    Number.isFinite(input.oldScale) && input.oldScale > 0 ? input.oldScale : 1;
  const newScale =
    Number.isFinite(input.newScale) && input.newScale > 0
      ? input.newScale
      : oldScale;
  const contentOffset = Number.isFinite(input.contentOffset)
    ? input.contentOffset || 0
    : 0;
  const contentCoordinate =
    (input.scrollOffset + input.pointerOffset - contentOffset) / oldScale;
  const nextScrollOffset =
    contentCoordinate * newScale + contentOffset - input.pointerOffset;
  const maxScrollOffset =
    Number.isFinite(input.maxScrollOffset) &&
    input.maxScrollOffset !== undefined
      ? Math.max(0, input.maxScrollOffset)
      : Number.POSITIVE_INFINITY;
  return clampPreviewValue(nextScrollOffset, 0, maxScrollOffset);
};

export const resolveAnchoredPreviewScrollOffsetFromCoordinate = (input: {
  contentCoordinate: number;
  pointerOffset: number;
  newScale: number;
  contentOffset?: number;
  maxScrollOffset?: number;
}): number => {
  const newScale =
    Number.isFinite(input.newScale) && input.newScale > 0 ? input.newScale : 1;
  const contentOffset = Number.isFinite(input.contentOffset)
    ? input.contentOffset || 0
    : 0;
  const nextScrollOffset =
    input.contentCoordinate * newScale + contentOffset - input.pointerOffset;
  const maxScrollOffset =
    Number.isFinite(input.maxScrollOffset) &&
    input.maxScrollOffset !== undefined
      ? Math.max(0, input.maxScrollOffset)
      : Number.POSITIVE_INFINITY;
  return clampPreviewValue(nextScrollOffset, 0, maxScrollOffset);
};

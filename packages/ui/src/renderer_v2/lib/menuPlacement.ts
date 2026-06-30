interface MenuAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FloatingMenuPlacementInput {
  anchorRect: MenuAnchorRect;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  gap?: number;
  preferredMaxHeight?: number;
}

interface FloatingMenuPlacementResult {
  top: number;
  left: number;
  maxHeight: number;
  maxWidth: number;
  direction: "above" | "below";
}

const clamp = (value: number, min: number, max: number): number => {
  if (max <= min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
};

const normalizeFinite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

export const resolveFloatingMenuPlacement = ({
  anchorRect,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = 8,
  gap = 4,
  preferredMaxHeight = 300,
}: FloatingMenuPlacementInput): FloatingMenuPlacementResult => {
  const resolvedMargin = Math.max(0, normalizeFinite(margin, 8));
  const resolvedGap = Math.max(0, normalizeFinite(gap, 4));
  const resolvedPreferredMaxHeight = Math.max(
    0,
    normalizeFinite(preferredMaxHeight, 300),
  );
  const resolvedViewportWidth = Math.max(0, normalizeFinite(viewportWidth, 0));
  const resolvedViewportHeight = Math.max(
    0,
    normalizeFinite(viewportHeight, 0),
  );
  const anchorBottom = anchorRect.top + anchorRect.height;
  const availableBelow = Math.max(
    0,
    resolvedViewportHeight - anchorBottom - resolvedGap - resolvedMargin,
  );
  const availableAbove = Math.max(
    0,
    anchorRect.top - resolvedGap - resolvedMargin,
  );
  const resolvedMaxWidth = Math.max(
    0,
    resolvedViewportWidth - resolvedMargin * 2,
  );
  const resolvedMenuWidth = Math.min(
    Math.max(0, normalizeFinite(menuWidth, 0)),
    resolvedMaxWidth,
  );
  const desiredMenuHeight = Math.min(
    Math.max(0, normalizeFinite(menuHeight, 0)),
    resolvedPreferredMaxHeight || Number.POSITIVE_INFINITY,
  );
  const direction: "above" | "below" =
    availableBelow >= desiredMenuHeight || availableBelow >= availableAbove
      ? "below"
      : "above";

  const maxHeight = Math.min(
    resolvedPreferredMaxHeight,
    direction === "below" ? availableBelow : availableAbove,
  );
  const renderedHeight = Math.min(
    desiredMenuHeight,
    direction === "below" ? availableBelow : availableAbove,
  );
  const top =
    direction === "below"
      ? clamp(
          anchorBottom + resolvedGap,
          resolvedMargin,
          resolvedViewportHeight - resolvedMargin - renderedHeight,
        )
      : clamp(
          anchorRect.top - resolvedGap - renderedHeight,
          resolvedMargin,
          resolvedViewportHeight - resolvedMargin - renderedHeight,
        );
  const left = clamp(
    anchorRect.left,
    resolvedMargin,
    resolvedViewportWidth - resolvedMargin - resolvedMenuWidth,
  );

  return {
    top,
    left,
    maxHeight,
    maxWidth: resolvedMaxWidth,
    direction,
  };
};

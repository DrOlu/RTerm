export interface ImeCompositionTracker {
  isComposing: boolean;
  suppressNextEnter: boolean;
  suppressTimer: ReturnType<typeof setTimeout> | null;
}

export interface ImeKeyboardEventLike {
  key?: string;
  keyCode?: number;
  which?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
  };
}

const COMPOSITION_KEY_CODE = 229;
const POST_COMPOSITION_ENTER_SUPPRESSION_MS = 50;

export const createImeCompositionTracker = (): ImeCompositionTracker => ({
  isComposing: false,
  suppressNextEnter: false,
  suppressTimer: null,
});

export const disposeImeCompositionTracker = (
  tracker: ImeCompositionTracker,
): void => {
  if (tracker.suppressTimer) {
    clearTimeout(tracker.suppressTimer);
  }
  tracker.suppressTimer = null;
  tracker.isComposing = false;
  tracker.suppressNextEnter = false;
};

export const markImeCompositionStart = (
  tracker: ImeCompositionTracker,
): void => {
  if (tracker.suppressTimer) {
    clearTimeout(tracker.suppressTimer);
  }
  tracker.suppressTimer = null;
  tracker.isComposing = true;
  tracker.suppressNextEnter = false;
};

export const markImeCompositionEnd = (tracker: ImeCompositionTracker): void => {
  if (tracker.suppressTimer) {
    clearTimeout(tracker.suppressTimer);
  }
  tracker.isComposing = false;
  tracker.suppressNextEnter = true;
  tracker.suppressTimer = setTimeout(() => {
    tracker.suppressTimer = null;
    tracker.suppressNextEnter = false;
  }, POST_COMPOSITION_ENTER_SUPPRESSION_MS);
};

const getEventKeyCode = (event: ImeKeyboardEventLike): number | undefined =>
  event.nativeEvent?.keyCode ??
  event.nativeEvent?.which ??
  event.keyCode ??
  event.which;

export const isNativeImeKeyEvent = (event: ImeKeyboardEventLike): boolean =>
  event.nativeEvent?.isComposing === true ||
  getEventKeyCode(event) === COMPOSITION_KEY_CODE;

export const shouldLetImeHandleKeyDown = (
  tracker: ImeCompositionTracker,
  event: ImeKeyboardEventLike,
): boolean =>
  event.key === "Enter" && (tracker.isComposing || isNativeImeKeyEvent(event));

export const shouldSuppressPostCompositionEnter = (
  tracker: ImeCompositionTracker,
  event: ImeKeyboardEventLike,
): boolean => {
  if (event.key !== "Enter" || !tracker.suppressNextEnter) {
    return false;
  }
  tracker.suppressNextEnter = false;
  if (tracker.suppressTimer) {
    clearTimeout(tracker.suppressTimer);
    tracker.suppressTimer = null;
  }
  return true;
};

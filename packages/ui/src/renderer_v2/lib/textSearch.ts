export interface TextSearchMatch {
  start: number;
  end: number;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

const normalizeNeedle = (value: string, caseSensitive: boolean): string =>
  caseSensitive ? value : value.toLocaleLowerCase();

export const findTextMatches = (
  text: string,
  query: string,
  options?: {
    caseSensitive?: boolean;
  },
): TextSearchMatch[] => {
  const source = String(text || "");
  const needle = String(query || "");
  if (!needle) {
    return [];
  }

  const caseSensitive = options?.caseSensitive === true;
  const normalizedSource = normalizeNeedle(source, caseSensitive);
  const normalizedNeedle = normalizeNeedle(needle, caseSensitive);
  const matches: TextSearchMatch[] = [];
  let startIndex = 0;

  while (startIndex <= normalizedSource.length - normalizedNeedle.length) {
    const matchIndex = normalizedSource.indexOf(normalizedNeedle, startIndex);
    if (matchIndex < 0) {
      break;
    }
    matches.push({
      start: matchIndex,
      end: matchIndex + normalizedNeedle.length,
    });
    startIndex = matchIndex + Math.max(1, normalizedNeedle.length);
  }

  return matches;
};

export const splitTextForHighlights = (
  text: string,
  matches: TextSearchMatch[],
): HighlightSegment[] => {
  const source = String(text || "");
  if (matches.length <= 0) {
    return [{ text: source, match: false }];
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;

  matches.forEach((match) => {
    if (match.start > cursor) {
      segments.push({
        text: source.slice(cursor, match.start),
        match: false,
      });
    }
    segments.push({
      text: source.slice(match.start, match.end),
      match: true,
    });
    cursor = match.end;
  });

  if (cursor < source.length) {
    segments.push({
      text: source.slice(cursor),
      match: false,
    });
  }

  return segments;
};

export const cycleSearchIndex = (
  currentIndex: number,
  total: number,
  direction: "next" | "previous",
): number => {
  if (total <= 0) {
    return -1;
  }
  if (currentIndex < 0 || currentIndex >= total) {
    return direction === "previous" ? total - 1 : 0;
  }
  return direction === "previous"
    ? (currentIndex - 1 + total) % total
    : (currentIndex + 1) % total;
};

export const isFindShortcutEvent = (
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): boolean =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === "f";

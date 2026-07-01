export type MentionSuggestionMode = "mention" | "pass-chat";

export const MENTION_SUGGESTION_MARGIN = 8;
export const MENTION_SUGGESTION_GAP = 6;
export const MENTION_SUGGESTION_MENU_WIDTH = 280;
export const MENTION_SUGGESTION_MAX_HEIGHT = 200;
export const PASS_CHAT_SUGGESTION_TITLE_LIMIT = 30;

export interface MentionSuggestionMenuDimensions {
  width: number;
  preferredMaxHeight: number;
}

export const truncatePassChatSuggestionTitle = (
  value: string,
  limit = PASS_CHAT_SUGGESTION_TITLE_LIMIT,
): string => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit).join("")}...`;
};

export const resolveMentionSuggestionMenuDimensions = (
  mode: MentionSuggestionMode,
  viewportWidth: number,
  margin = MENTION_SUGGESTION_MARGIN,
): MentionSuggestionMenuDimensions => {
  void mode;
  const preferredWidth = MENTION_SUGGESTION_MENU_WIDTH;
  const preferredMaxHeight = MENTION_SUGGESTION_MAX_HEIGHT;
  const viewportMaxWidth = Math.max(0, viewportWidth - Math.max(0, margin) * 2);

  return {
    width: Math.min(preferredWidth, viewportMaxWidth),
    preferredMaxHeight,
  };
};

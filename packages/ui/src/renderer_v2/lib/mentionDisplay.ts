export const MENTION_DISPLAY_CHAR_LIMIT = 18;

export const truncateMentionDisplayText = (value: string): string => {
  const text = String(value || "");
  const chars = Array.from(text);
  if (chars.length <= MENTION_DISPLAY_CHAR_LIMIT) {
    return text;
  }
  return `${chars.slice(0, MENTION_DISPLAY_CHAR_LIMIT).join("")}...`;
};

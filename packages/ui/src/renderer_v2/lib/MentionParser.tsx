import React from 'react';
import { getFileMentionDisplayName } from './filesystemDragDrop';

/**
 * Shared by:
 * 1) Chat message/queue mention rendering (`components/Chat/MessageRow.tsx`, `components/Chat/Queue/QueueCard.tsx`)
 * 2) Session-title text normalization (`lib/sessionTitleDisplay.ts`)
 */
const MENTION_TOKEN_REGEX = /(\[MENTION_(?:SKILL|TAB|FILE|IMAGE):#.+?#(?:#.+?#)?\])/g;

const getFileDisplayName = (path: string): string => {
  return getFileMentionDisplayName(path) || path;
};

const mentionTokenToText = (token: string): string | null => {
  const skillMatch = token.match(/^\[MENTION_SKILL:#(.+?)#\]$/);
  if (skillMatch) {
    return `@${skillMatch[1]}`;
  }

  const terminalMatch = token.match(/^\[MENTION_TAB:#(.+?)##(.+?)#\]$/);
  if (terminalMatch) {
    return `@${terminalMatch[1]}`;
  }

  const fileMatch = token.match(/^\[MENTION_FILE:#(.+?)#\]$/);
  if (fileMatch) {
    return getFileDisplayName(fileMatch[1]);
  }

  const imageMatch = token.match(/^\[MENTION_IMAGE:#(.+?)(?:##(.+?))?#\]$/);
  if (imageMatch) {
    const explicitName = String(imageMatch[2] || '').trim();
    return explicitName || getFileDisplayName(imageMatch[1]);
  }

  return null;
};

/**
 * Convert mention labels to plain display text.
 * This is intended for places like session titles where we only need text,
 * not badge-like styled labels.
 */
export const renderMentionText = (content: string): string => {
  if (!content) return '';

  let text = content
    .split(MENTION_TOKEN_REGEX)
    .map((part) => mentionTokenToText(part) ?? part)
    .join('');

  // Session titles can be truncated (e.g. first 20 chars), leaving incomplete tags.
  // Fallback to the same visible text rule for dangling mention patterns.
  text = text
    .replace(/\[MENTION_TAB:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g, (_m, name: string) => `@${name}`)
    .replace(/\[MENTION_SKILL:#([^#\]\r\n]+)(?:#\])?/g, (_m, name: string) => `@${name}`)
    .replace(/\[MENTION_FILE:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g, (_m, path: string) => getFileDisplayName(path))
    .replace(/\[MENTION_IMAGE:#([^#\]\r\n]+)(?:##([^#\]\r\n]+))?(?:#\])?/g, (_m, path: string, name: string) =>
      String(name || '').trim() || getFileDisplayName(path)
    );

  return text;
};

/**
 * Unified logic for parsing and rendering Mention tags.
 * Converts text in the format [MENTION_XXX:#...#] into an array of React nodes.
 */
export const renderMentionContent = (content: string): (string | React.ReactElement)[] => {
  if (!content) return [];

  const parts = content.split(MENTION_TOKEN_REGEX);

  return parts.map((part, i) => {
    const mentionText = mentionTokenToText(part);
    if (!mentionText) {
      return part;
    }

    if (mentionText.startsWith('@')) {
      const cls = part.startsWith('[MENTION_TAB:')
        ? 'terminal'
        : part.startsWith('[MENTION_SKILL:')
          ? 'skill'
          : 'terminal';
      return (
        <span key={`mention-${i}`} className={`mention-badge ${cls}`}>
          {mentionText}
        </span>
      );
    }

    if (part.startsWith('[MENTION_FILE:') || part.startsWith('[MENTION_IMAGE:')) {
      return (
        <span key={`mention-${i}`} className="mention-badge file">
          {mentionText}
        </span>
      );
    }

    return part;
  });
};

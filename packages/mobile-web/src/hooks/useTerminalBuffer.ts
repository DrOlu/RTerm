import React from "react";

import type { GatewayClient } from "../gateway-client";
import type { TerminalBufferSnapshot } from "../types";

/**
 * Polling-based read-only terminal buffer snapshot.
 *
 * Design rationale (see mobile-web v2 plan, Phase 1):
 * - Mobile-web is a monitoring surface, not an interactive terminal. We deliberately
 *   use `terminal:getBufferDelta` polling instead of a live TTY stream because:
 *   1. xterm.js + IME + on-screen keyboard on mobile is a poor experience and conflicts
 *      with GyShell's "steer via Agent chat" paradigm.
 *   2. Incremental polling is cheap on battery/bandwidth vs. a persistent push channel.
 *   3. The backend already exposes getBufferDelta precisely for this monitoring use case.
 *
 * The hook keeps a per-terminal rolling tail (max TAIL_MAX_LINES lines) and exposes
 * a map of terminalId -> snapshot. It pauses automatically when the client disconnects
 * or when no terminals are present.
 */

const POLL_INTERVAL_MS = 2000;
const TAIL_MAX_CHARS = 16000;

export interface TerminalBufferEntry {
  terminalId: string;
  text: string;
  offset: number;
  updatedAt: number;
  hasNew: boolean;
}

export interface UseTerminalBufferResult {
  buffers: Record<string, TerminalBufferEntry>;
  /** Mark a terminal's latest tail as "seen" so the new-output indicator clears. */
  markSeen: (terminalId: string) => void;
  /** Force an immediate refresh of all terminals (e.g. on tab focus). */
  refresh: () => void;
}

function trimTail(text: string): string {
  if (text.length <= TAIL_MAX_CHARS) return text;
  const cut = text.slice(text.length - TAIL_MAX_CHARS);
  const newlineIndex = cut.indexOf("\n");
  return newlineIndex >= 0 ? cut.slice(newlineIndex + 1) : cut;
}

function countTrailingNewlines(text: string): number {
  let count = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === "\n") {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

export const __test__ = { trimTail, countTrailingNewlines, TAIL_MAX_CHARS };

export function useTerminalBuffer(
  client: GatewayClient,
  isConnected: boolean,
  terminalIds: string[],
): UseTerminalBufferResult {
  const [buffers, setBuffers] = React.useState<Record<string, TerminalBufferEntry>>(
    {},
  );
  const clientRef = React.useRef(client);
  clientRef.current = client;
  const connectedRef = React.useRef(isConnected);
  connectedRef.current = isConnected;
  const terminalIdsKey = terminalIds.slice().sort().join("|");
  const terminalIdsRef = React.useRef(terminalIds);
  terminalIdsRef.current = terminalIds;
  const inFlightRef = React.useRef(false);
  const seenOffsetsRef = React.useRef<Record<string, number>>({});
  // Mirror of `buffers` kept in a ref so the polling tick can read the latest
  // tail/offset without depending on the state in its useCallback deps.
  // Without this indirection, tick would depend on `buffers`, every poll would
  // recreate tick, and the polling effect would re-run immediately (rescheduling
  // the very first tick) — effectively polling as fast as RTT instead of every
  // POLL_INTERVAL_MS.
  const buffersRef = React.useRef<Record<string, TerminalBufferEntry>>({});
  const syncBuffersRef = (next: Record<string, TerminalBufferEntry>) => {
    buffersRef.current = next;
  };

  const tick = React.useCallback(async () => {
    if (!connectedRef.current || inFlightRef.current) return;
    const ids = terminalIdsRef.current;
    if (ids.length === 0) return;
    inFlightRef.current = true;
    try {
      const results = await Promise.all(
        ids.map(async (terminalId) => {
          try {
            const previous = buffersRef.current[terminalId];
            const fromOffset = previous?.offset ?? 0;
            const payload = await clientRef.current.request<TerminalBufferSnapshot>(
              "terminal:getBufferDelta",
              { terminalId, fromOffset },
            );
            const data = String(payload?.data ?? "");
            const offset = Number.isFinite(payload?.offset)
              ? Number(payload.offset)
              : fromOffset;
            const baseText = previous?.text ?? "";
            const nextTextRaw = data ? baseText + data : baseText;
            const nextText = trimTail(nextTextRaw);
            // Seed the seen baseline on the very first snapshot for this
            // terminal so subsequent polls have something to compare against.
            // Without this, `seen` defaulted to the current `offset`, making
            // `offset > seen` always false — so new output was never flagged
            // unread and markSeen (gated on hasNew) never persisted a baseline
            // either, locking the badge off forever.
            const isFirstSnapshot = !previous;
            if (isFirstSnapshot) {
              seenOffsetsRef.current[terminalId] = offset;
            }
            const seen = seenOffsetsRef.current[terminalId] ?? offset;
            const hasNew =
              !isFirstSnapshot &&
              offset > seen &&
              (data.length > 0 || countTrailingNewlines(nextText) > 0);
            const entry: TerminalBufferEntry = {
              terminalId,
              text: nextText,
              offset,
              updatedAt: Date.now(),
              hasNew,
            };
            return { terminalId, entry };
          } catch {
            return null;
          }
        }),
      );
      setBuffers((previous) => {
        const next: Record<string, TerminalBufferEntry> = {};
        const keep = new Set(ids);
        for (const [id, entry] of Object.entries(previous)) {
          if (keep.has(id)) {
            next[id] = entry;
          }
        }
        for (const result of results) {
          if (!result) continue;
          next[result.terminalId] = result.entry;
        }
        syncBuffersRef(next);
        return next;
      });
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const refresh = React.useCallback(() => {
    void tick();
  }, [tick]);

  const markSeen = React.useCallback((terminalId: string) => {
    if (!terminalId) return;
    setBuffers((previous) => {
      const entry = previous[terminalId];
      if (!entry || !entry.hasNew) return previous;
      seenOffsetsRef.current[terminalId] = entry.offset;
      const next = {
        ...previous,
        [terminalId]: { ...entry, hasNew: false },
      };
      syncBuffersRef(next);
      return next;
    });
  }, []);

  // Reset all tracking state when connection drops so stale data is never shown.
  React.useEffect(() => {
    if (isConnected) return;
    const next: Record<string, TerminalBufferEntry> = {};
    syncBuffersRef(next);
    setBuffers(next);
    seenOffsetsRef.current = {};
  }, [isConnected]);

  // Drop tracking state for terminals that no longer exist.
  React.useEffect(() => {
    setBuffers((previous) => {
      const keep = new Set(terminalIds);
      let changed = false;
      const next: Record<string, TerminalBufferEntry> = {};
      for (const [id, entry] of Object.entries(previous)) {
        if (keep.has(id)) {
          next[id] = entry;
        } else {
          changed = true;
        }
      }
      if (changed) syncBuffersRef(next);
      return changed ? next : previous;
    });
  }, [terminalIdsKey]);

  // Polling lifecycle: restart whenever the active terminal set changes.
  React.useEffect(() => {
    if (!isConnected) return;
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [isConnected, terminalIdsKey, tick]);

  return { buffers, markSeen, refresh };
}

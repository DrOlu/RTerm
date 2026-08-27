/**
 * SafeMemorySaver — MemorySaver that cannot OOM the process.
 *
 * LangGraph's default MemorySaver JSON-serializes the entire graph state on
 * every node (JsonPlusSerializer → TextEncoder.encode). After a long agent
 * run the checkpoint includes every tool result (terminal dumps, file
 * contents, fleet output). That blob can be hundreds of MB; V8 then throws
 * `RangeError: Failed to allocate memory` — typically AFTER the answer is
 * already shown, which matches "error after completing a task".
 *
 * This wrapper:
 *   1. Prunes oversized tool / string payloads BEFORE serialize.
 *   2. Caps the serialized checkpoint; if still too big, drops older
 *      messages rather than crashing.
 *   3. Swallows a residual allocation failure so a finished run cannot
 *      take down the process. The in-memory graph still has the state;
 *      we just skip persisting that particular checkpoint.
 */

import { MemorySaver } from "@langchain/langgraph-checkpoint";

/** Soft cap for a single string field inside a checkpoint (tool output, etc.). */
export const CHECKPOINT_STRING_CAP = 8 * 1024;

/** Hard cap for one serialized checkpoint / writes blob. */
export const CHECKPOINT_BYTES_CAP = 16 * 1024 * 1024;

/** Keep at most this many messages when we have to drop history. */
export const CHECKPOINT_MAX_MESSAGES = 40;

export function estimateUtf8Bytes(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function truncateString(input: string, max = CHECKPOINT_STRING_CAP): string {
  if (input.length <= max) return input;
  const omitted = input.length - max;
  return `${input.slice(0, max)}\n...[truncated ${omitted} chars for checkpoint]...`;
}

function pruneValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[pruned: depth]";
  if (typeof value === "string") return truncateString(value);
  if (Array.isArray(value)) {
    return value.map((item) => pruneValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = pruneValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function pruneMessagesArray(messages: unknown[]): unknown[] {
  const pruned = messages.map((m) => pruneValue(m));
  if (pruned.length <= CHECKPOINT_MAX_MESSAGES) return pruned;
  const keep = CHECKPOINT_MAX_MESSAGES - 1;
  const dropped = pruned.length - keep;
  return [
    {
      type: "system",
      content: `[checkpoint] dropped ${dropped} older messages to stay under memory cap`,
    },
    ...pruned.slice(-keep),
  ];
}

/**
 * Mutate a LangGraph checkpoint in place so JsonPlusSerializer can encode it
 * without allocating a gigantic string. Returns a shallow-copied checkpoint.
 */
export function pruneCheckpointForSaver(checkpoint: unknown): unknown {
  if (!checkpoint || typeof checkpoint !== "object") return checkpoint;
  const cp = checkpoint as Record<string, unknown>;
  const next: Record<string, unknown> = { ...cp };

  const channelValues = cp.channel_values;
  if (channelValues && typeof channelValues === "object") {
    const channels = { ...(channelValues as Record<string, unknown>) };
    if (Array.isArray(channels.messages)) {
      channels.messages = pruneMessagesArray(channels.messages);
    }
    for (const [k, v] of Object.entries(channels)) {
      if (k === "messages") continue;
      channels[k] = pruneValue(v);
    }
    next.channel_values = channels;
  }

  if ("pending_sends" in next) {
    next.pending_sends = pruneValue(next.pending_sends);
  }
  return next;
}

export function isAllocationError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  return (
    name === "RangeError" ||
    /failed to allocate memory|invalid string length|array buffer allocation failed|Cannot allocate|ERR_STRING_TOO_LONG/i.test(
      msg,
    )
  );
}

export class SafeMemorySaver extends MemorySaver {
  override async put(config: any, checkpoint: any, metadata: any): Promise<any> {
    const pruned = pruneCheckpointForSaver(checkpoint);
    try {
      return await super.put(config, pruned as any, pruneValue(metadata) as any);
    } catch (error) {
      if (!isAllocationError(error)) throw error;
      console.warn(
        "[SafeMemorySaver] checkpoint serialize OOM — dropping older messages and retrying",
      );
      try {
        const tighter = pruneCheckpointForSaver(pruned) as Record<string, unknown>;
        const channels = (tighter.channel_values ?? {}) as Record<string, unknown>;
        if (Array.isArray(channels.messages)) {
          channels.messages = channels.messages.slice(-8);
        }
        tighter.channel_values = channels;
        return await super.put(config, tighter as any, { source: "oom-pruned" } as any);
      } catch (retryError) {
        if (!isAllocationError(retryError)) throw retryError;
        console.warn(
          "[SafeMemorySaver] checkpoint still too large — skipping persist so the run can finish",
        );
        return {
          configurable: {
            thread_id: config?.configurable?.thread_id,
            checkpoint_ns: config?.configurable?.checkpoint_ns ?? "",
            checkpoint_id: checkpoint?.id,
          },
        };
      }
    }
  }

  override async putWrites(config: any, writes: any, taskId: any): Promise<any> {
    const prunedWrites = Array.isArray(writes)
      ? writes.map((w: unknown) => {
          if (Array.isArray(w) && w.length >= 2) {
            return [w[0], pruneValue(w[1]), ...w.slice(2)];
          }
          return pruneValue(w);
        })
      : writes;
    try {
      return await super.putWrites(config, prunedWrites, taskId);
    } catch (error) {
      if (!isAllocationError(error)) throw error;
      console.warn(
        "[SafeMemorySaver] putWrites serialize OOM — skipping writes persist",
      );
    }
  }
}

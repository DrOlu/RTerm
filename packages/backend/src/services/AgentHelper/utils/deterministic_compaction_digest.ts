import type { BaseMessage } from "@langchain/core/messages";
import { hasAnyNormalUserInputTag } from "../prompts";
import { TokenManager } from "../TokenManager";

export interface DeterministicCompactionDigestInput {
  messages: BaseMessage[];
  totalMessageCount: number;
  protectedTailMessageCount: number;
  maxChars?: number;
}

export interface DeterministicCompactionDigestResult {
  digest: string;
  selectedEntryCount: number;
  omittedEntryCount: number;
}

const DEFAULT_MAX_CHARS = 50_000;
const MIN_MAX_CHARS = 2_000;

interface DigestEntry {
  index: number;
  required: boolean;
  text: string;
}

export function buildDeterministicCompactionDigest(
  input: DeterministicCompactionDigestInput,
): DeterministicCompactionDigestResult {
  const maxChars = Math.max(MIN_MAX_CHARS, input.maxChars ?? DEFAULT_MAX_CHARS);
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const entries = buildDigestEntries(messages);
  const selected = selectEntries(entries, maxChars);
  const ordered = selected.entries.sort(
    (left, right) => left.index - right.index,
  );

  const body = ordered.map((entry) => entry.text).join("\n\n");
  const omittedEntryCount = Math.max(0, entries.length - ordered.length);
  const header = [
    "Emergency deterministic compaction summary generated locally after model compaction failed.",
    `Original backend messages: ${input.totalMessageCount}.`,
    `Compacted prefix messages represented here: ${messages.length}.`,
    `Protected tail messages kept verbatim after this summary: ${input.protectedTailMessageCount}.`,
    `Selected digest entries: ${ordered.length}; omitted digest entries: ${omittedEntryCount}.`,
    "This is a lossy, deterministic digest. Prefer the protected tail for recent exact context and use the exported history file when exact older details are needed.",
  ].join("\n");

  const digest = constrainText(
    body ? `${header}\n\n${body}` : header,
    maxChars,
  );

  return {
    digest,
    selectedEntryCount: ordered.length,
    omittedEntryCount,
  };
}

function buildDigestEntries(messages: BaseMessage[]): DigestEntry[] {
  const entries: DigestEntry[] = [];
  let firstNormalUser = true;

  messages.forEach((message, index) => {
    const raw = extractMessageText(message).trim();
    if (!raw) return;

    const type = getMessageType(message);
    const isNormalUser =
      type === "human" && hasAnyNormalUserInputTag(message.content);
    const isLeadingSystem = type === "system" && index < 3;
    const maxChars = getEntryCharLimit(type, isNormalUser, firstNormalUser);
    const flags = formatMessageFlags(message);
    const heading = `[${index + 1}/${messages.length} ${type}${flags}]`;
    const text = `${heading}\n${clipMiddle(raw, maxChars)}`;

    entries.push({
      index,
      required: isLeadingSystem || (isNormalUser && firstNormalUser),
      text,
    });

    if (isNormalUser) {
      firstNormalUser = false;
    }
  });

  return entries;
}

function selectEntries(
  entries: DigestEntry[],
  maxChars: number,
): { entries: DigestEntry[]; usedChars: number } {
  const reservedHeaderChars = 900;
  const budget = Math.max(0, maxChars - reservedHeaderChars);
  const selected: DigestEntry[] = [];
  let usedChars = 0;

  const required = entries.filter((entry) => entry.required);
  const optionalNewestFirst = entries
    .filter((entry) => !entry.required)
    .sort((left, right) => right.index - left.index);

  for (const entry of [...required, ...optionalNewestFirst]) {
    const cost = entry.text.length + (selected.length > 0 ? 2 : 0);
    if (usedChars + cost > budget) {
      if (!entry.required) continue;
      const remaining = Math.max(
        0,
        budget - usedChars - (selected.length > 0 ? 2 : 0),
      );
      if (remaining > 200) {
        selected.push({
          ...entry,
          text: constrainText(entry.text, remaining),
        });
        usedChars = budget;
      }
      continue;
    }
    selected.push(entry);
    usedChars += cost;
  }

  return { entries: selected, usedChars };
}

function getEntryCharLimit(
  type: string,
  isNormalUser: boolean,
  isFirstNormalUser: boolean,
): number {
  if (type === "system") return 2_200;
  if (isNormalUser) return isFirstNormalUser ? 3_000 : 1_200;
  if (type === "tool") return 850;
  if (type === "ai") return 520;
  if (type === "human") return 900;
  return 600;
}

function formatMessageFlags(message: BaseMessage): string {
  const flags: string[] = [];
  if (TokenManager.hasPruneLabel(message)) flags.push("pruned");
  if (TokenManager.hasLastCompactionFlag(message))
    flags.push("last_compaction");
  return flags.length > 0 ? ` ${flags.join(",")}` : "";
}

function getMessageType(message: BaseMessage): string {
  const type =
    typeof (message as any).getType === "function"
      ? (message as any).getType()
      : (message as any).type;
  return typeof type === "string" && type.length > 0 ? type : "unknown";
}

function extractMessageText(message: BaseMessage): string {
  return contentToText(message.content);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => contentToTextPart(part)).join("\n");
  }
  return safeStringify(content);
}

function contentToTextPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return String(part ?? "");
  const maybeText = (part as any).text ?? (part as any).content;
  if (typeof maybeText === "string") return maybeText;
  return safeStringify(part);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function clipMiddle(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const marker = `\n...[truncated ${input.length - maxChars} chars]...\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.64);
  const tailLength = Math.max(0, available - headLength);
  return `${input.slice(0, headLength)}${marker}${tailLength > 0 ? input.slice(-tailLength) : ""}`;
}

function constrainText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return clipMiddle(input, maxChars);
}

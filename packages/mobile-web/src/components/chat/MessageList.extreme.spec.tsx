import React from "react";
import {
  areMessageListPropsEqual,
  type MessageListProps,
} from "./MessageList";
import type { ChatTimelineItem } from "../../lib/chat-timeline";
import type { ChatMessage } from "../../types";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
}

function runCase(name: string, fn: () => void): void {
  fn();
  console.log(`PASS ${name}`);
}

const noopAsk = (_message: ChatMessage, _decision: "allow" | "deny") => {};
const noopDetail = (_turnId: string) => {};
const noopMessage = (_message: ChatMessage) => {};
const listRef = React.createRef<HTMLDivElement>();

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id ?? "m1",
    role: overrides.role ?? "assistant",
    type: overrides.type ?? "text",
    content: overrides.content ?? "",
    timestamp: overrides.timestamp ?? 1,
    backendMessageId: overrides.backendMessageId,
    metadata: overrides.metadata,
    streaming: overrides.streaming,
  };
}

const userMessage = makeMessage({
  id: "user-1",
  role: "user",
  content: "hello",
  backendMessageId: "backend-user-1",
});
const assistantMessage = makeMessage({
  id: "assistant-1",
  role: "assistant",
  content: "world",
  backendMessageId: "backend-assistant-1",
});
const items: ChatTimelineItem[] = [
  {
    kind: "user",
    id: userMessage.id,
    message: userMessage,
  },
  {
    kind: "agent",
    id: `agent-${assistantMessage.id}`,
    latestMessage: assistantMessage,
    detailMessages: [assistantMessage],
    startedAt: assistantMessage.timestamp,
    streaming: false,
  },
];

function makeProps(overrides: Partial<MessageListProps> = {}): MessageListProps {
  return {
    items,
    onAskDecision: noopAsk,
    onOpenDetail: noopDetail,
    onRollback: noopMessage,
    onBranch: noopMessage,
    rollbackDisabled: false,
    branchDisabled: false,
    listRef,
    ...overrides,
  };
}

runCase("message list props are equal across composer-only parent renders", () => {
  const previous = makeProps();
  const next = makeProps();

  assertEqual(
    areMessageListPropsEqual(previous, next),
    true,
    "stable message props should allow React.memo to skip rerender",
  );
});

runCase("message list props change when timeline identity changes", () => {
  const previous = makeProps();
  const next = makeProps({ items: [...items] });

  assertEqual(
    areMessageListPropsEqual(previous, next),
    false,
    "new timeline identity must rerender the list",
  );
});

runCase("message list props change when branch actions change", () => {
  const previous = makeProps();
  const next = makeProps({ onBranch: (_message) => {} });

  assertEqual(
    areMessageListPropsEqual(previous, next),
    false,
    "new branch callback must rerender actionable user bubbles",
  );
});

runCase("message list props change when command disabled state changes", () => {
  const previous = makeProps();
  const next = makeProps({ rollbackDisabled: true });

  assertEqual(
    areMessageListPropsEqual(previous, next),
    false,
    "rollback disabled state must refresh user bubble buttons",
  );
});

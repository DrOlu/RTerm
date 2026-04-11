import assert from "node:assert/strict";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from "@langchain/core/messages";
import { sanitizeStoredMessagesForChatRuntime } from "./model_messages";

function runCase(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

runCase("sanitizeStoredMessagesForChatRuntime drops invalid generic history messages", () => {
  const validStoredMessages = mapChatMessagesToStoredMessages([
    new SystemMessage("system"),
    new HumanMessage("user"),
    new ToolMessage({
      content: "tool output",
      tool_call_id: "call-1",
      name: "exec_command",
    }),
  ]) as any[];

  const invalidGenericStoredMessage = {
    type: "generic",
    data: {
      content: "",
      additional_kwargs: {},
      response_metadata: {},
      id: "bad-generic-message",
    },
  };

  const result = sanitizeStoredMessagesForChatRuntime([
    ...validStoredMessages,
    invalidGenericStoredMessage,
  ]);

  assert.equal(result.removedCount, 1);
  assert.equal(result.messages.length, validStoredMessages.length);

  const restored = mapStoredMessagesToChatMessages(result.messages as any[]);
  assert.equal(restored.length, validStoredMessages.length);
  assert.equal(restored[0]?.type, "system");
  assert.equal(restored[1]?.type, "human");
  assert.equal(restored[2]?.type, "tool");
});

import React from "react";
import { CornerUpLeft } from "lucide-react";
import { formatClock, messageDetail, messageTypeTitle } from "../../format";
import { useMobileI18n } from "../../i18n/provider";
import {
  type AgentTimelineItem,
  type ChatTimelineItem,
} from "../../lib/chat-timeline";
import { normalizeDisplayText, trimOuterBlankLines } from "../../session-store";
import type { ChatMessage } from "../../types";
import { MarkdownContent } from "../common/MarkdownContent";
import { MentionContent } from "../common/MentionContent";

interface MessageListProps {
  items: ChatTimelineItem[];
  onAskDecision: (message: ChatMessage, decision: "allow" | "deny") => void;
  onOpenDetail: (turnId: string) => void;
  onRollback: (message: ChatMessage) => void;
  rollbackDisabled: boolean;
  listRef: React.RefObject<HTMLDivElement>;
}

const UserBubble: React.FC<{
  message: ChatMessage;
  onRollback: (message: ChatMessage) => void;
  rollbackDisabled: boolean;
}> = ({ message, onRollback, rollbackDisabled }) => {
  const { t } = useMobileI18n();
  const displayText = trimOuterBlankLines(
    normalizeDisplayText(String(message.content || "")),
  );
  const inputImages = message.metadata?.inputImages || [];
  if (!displayText.trim() && inputImages.length === 0) return null;
  const canRollback =
    !!message.backendMessageId && !message.streaming && !rollbackDisabled;

  return (
    <article className="bubble-row user">
      <div className="bubble user">
        {displayText.trim() ? (
          <p>
            <MentionContent text={displayText} />
          </p>
        ) : null}
        {inputImages.length > 0 ? (
          <div className="bubble-user-images">
            {inputImages.map((image, index) => (
              <div key={`${image.attachmentId || "image"}-${index}`} className="bubble-user-image-chip">
                {String(image.previewDataUrl || "").trim() ? (
                  <img
                    src={String(image.previewDataUrl || "")}
                    alt={image.fileName || image.attachmentId || "image"}
                    loading="lazy"
                  />
                ) : (
                  <div className="bubble-user-image-placeholder">IMG</div>
                )}
                <span>{image.fileName || image.attachmentId || "image"}</span>
              </div>
            ))}
          </div>
        ) : null}
        <footer>
          <span>{formatClock(message.timestamp)}</span>
          {message.streaming ? (
            <span className="streaming">{t.common.streaming}</span>
          ) : null}
          <button
            type="button"
            className="bubble-rollback-btn"
            onClick={() => onRollback(message)}
            disabled={!canRollback}
            title={t.messageList.rollbackAndEdit}
          >
            <CornerUpLeft size={14} />
            <span>{t.messageList.rollback}</span>
          </button>
        </footer>
      </div>
    </article>
  );
};

const AgentTurnBubble: React.FC<{
  item: AgentTimelineItem;
  onAskDecision: (message: ChatMessage, decision: "allow" | "deny") => void;
  onOpenDetail: (turnId: string) => void;
}> = ({ item, onAskDecision, onOpenDetail }) => {
  const { t } = useMobileI18n();
  const message = item.latestMessage;
  const messageTitle = messageTypeTitle(message, t.format);
  const preview = trimOuterBlankLines(messageDetail(message, t.format));
  const isText = message.type === "text";
  const isAsk = message.type === "ask";
  const isReasoning = message.type === "reasoning";
  const isCompaction = message.type === "compaction";
  const isToolLike =
    message.type === "command" ||
    message.type === "tool_call" ||
    message.type === "file_edit" ||
    message.type === "sub_tool" ||
    isReasoning ||
    isCompaction;
  const isSpecialActivity = (isReasoning || isCompaction) && item.streaming;
  const titleClassName = `agent-event-title${isReasoning || isCompaction ? " special" : ""}${isReasoning ? " reasoning" : ""}${isCompaction ? " compaction" : ""}${isSpecialActivity ? " sweeping" : ""}`;
  const decision = message.metadata?.decision;
  const showDecisionButtons =
    isAsk && decision !== "allow" && decision !== "deny";
  const markdownPreview = trimOuterBlankLines(
    normalizeDisplayText(message.content || ""),
  );
  const textPreview = markdownPreview || (item.streaming ? "..." : "");
  const eventPreview = isCompaction ? preview : preview || (item.streaming ? "..." : "");
  const shouldClampTextPreview = item.streaming;

  return (
    <article className="bubble-row assistant">
      <div className="bubble assistant agent-turn">
        {isText ? (
          <MarkdownContent
            className={`bubble-markdown ${shouldClampTextPreview ? "streaming-clamped" : ""} ${
              markdownPreview ? "" : "placeholder"
            }`}
            content={textPreview}
          />
        ) : (
          <div className="agent-event-preview">
            <div className={titleClassName}>{messageTitle}</div>
            {eventPreview ? (
              <pre
                className={`agent-event-body ${isToolLike ? "tool-fixed" : ""}${isCompaction ? " compaction" : ""}`}
              >
                {eventPreview}
              </pre>
            ) : null}
          </div>
        )}

        {showDecisionButtons ? (
          <div className="decision-actions">
            <button
              type="button"
              className="accent-btn"
              onClick={() => onAskDecision(message, "allow")}
            >
              {t.common.allow}
            </button>
            <button
              type="button"
              className="danger-btn"
              onClick={() => onAskDecision(message, "deny")}
            >
              {t.common.deny}
            </button>
          </div>
        ) : null}

        {isAsk && decision ? (
          <p className="decision-result">{t.common.decision(decision)}</p>
        ) : null}

        <footer>
          <span>{formatClock(message.timestamp || item.startedAt)}</span>
          {item.streaming ? (
            <span className="streaming">{t.common.streaming}</span>
          ) : null}
          <button
            type="button"
            className="bubble-detail-btn"
            onClick={() => onOpenDetail(item.id)}
          >
            {t.common.details}
          </button>
        </footer>
      </div>
    </article>
  );
};

export const MessageList: React.FC<MessageListProps> = ({
  items,
  onAskDecision,
  onOpenDetail,
  onRollback,
  rollbackDisabled,
  listRef,
}) => {
  const { t } = useMobileI18n();

  return (
    <main className="message-list" ref={listRef}>
      {items.length === 0 ? (
        <div className="empty-state">
          <p>{t.messageList.emptyTitle}</p>
          <p>{t.messageList.emptyHint}</p>
        </div>
      ) : (
        items.map((item) => {
          if (item.kind === "user") {
            return (
              <UserBubble
                key={item.id}
                message={item.message}
                onRollback={onRollback}
                rollbackDisabled={rollbackDisabled}
              />
            );
          }
          return (
            <AgentTurnBubble
              key={item.id}
              item={item}
              onAskDecision={onAskDecision}
              onOpenDetail={onOpenDetail}
            />
          );
        })
      )}
    </main>
  );
};

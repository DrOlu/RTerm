import type { ChatSession } from "../types";
import type {
  ChatSessionSummaryRecord,
  StoredChatSessionRecord,
} from "./history/historyTypes";
import { HistorySqliteStore } from "./history/HistorySqliteStore";

export type StoredChatSession = StoredChatSessionRecord;

export interface StoredChatHistory {
  sessions: StoredChatSession[];
}

interface ChatHistoryServiceOptions {
  store?: HistorySqliteStore;
}

export class ChatHistoryService {
  private readonly store: HistorySqliteStore;

  constructor(options?: ChatHistoryServiceOptions) {
    this.store = options?.store || new HistorySqliteStore();
  }

  saveSession(session: ChatSession): void {
    // FREEZE FIX: was `this.store.loadChatSession(session.id)` purely to read
    // `createdAt`. That parsed every stored message of the session (measured
    // ~1.5 s / ~117 MB on a 6k-message session) and discarded the result on
    // EVERY save. The scalar read below is a single indexed row.
    // `store.saveChatSession` also preserves an existing created_at on
    // conflict, so this value only matters for a brand-new session.
    const createdAt = this.store.getChatSessionCreatedAt(session.id);
    const now = Date.now();

    this.store.saveChatSession({
      id: session.id,
      title: session.title,
      messages: Array.from(session.messages.entries()).map(([id, message]) => ({
        id,
        type: (message as any)._getType
          ? (message as any)._getType()
          : "unknown",
        data: message,
      })),
      lastCheckpointOffset: session.lastCheckpointOffset,
      lastProfileMaxTokens: session.lastProfileMaxTokens,
      createdAt: createdAt || now,
      updatedAt: now,
    });
  }

  /**
   * Session row only (title/createdAt) — never parses stored messages.
   * Used on the checkpoint save path, which previously paid a full session
   * parse just to preserve the title.
   */
  getSessionMeta(
    sessionId: string,
  ): { createdAt: number; title: string } | null {
    return this.store.getChatSessionMeta(sessionId);
  }

  loadSession(sessionId: string): ChatSession | null {
    const storedSession = this.store.loadChatSession(sessionId);
    if (!storedSession) {
      return null;
    }

    const messages = new Map<string, any>();
    for (const message of storedSession.messages) {
      messages.set(message.id, message.data);
    }

    return {
      id: storedSession.id,
      title: storedSession.title,
      messages,
      lastCheckpointOffset: storedSession.lastCheckpointOffset,
      lastProfileMaxTokens: storedSession.lastProfileMaxTokens,
    };
  }

  getAllSessions(): StoredChatSession[] {
    return this.store.listChatSessions();
  }

  getAllSessionSummaries(): ChatSessionSummaryRecord[] {
    return this.store.listChatSessionSummaries();
  }

  deleteSession(sessionId: string): void {
    this.store.deleteChatSessions([sessionId]);
  }

  deleteSessions(sessionIds: string[]): void {
    this.store.deleteChatSessions(sessionIds);
  }

  clearAll(): void {
    this.store.clearChatSessions();
  }

  renameSession(sessionId: string, newTitle: string): void {
    this.store.renameChatSession(sessionId, newTitle, Date.now());
  }

  exportSession(sessionId: string): StoredChatSession | null {
    return this.store.loadChatSession(sessionId);
  }
}

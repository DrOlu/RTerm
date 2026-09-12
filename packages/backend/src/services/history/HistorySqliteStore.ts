import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, UIChatSession } from "../../types/ui-chat";
import type {
  ChatSessionSummaryRecord,
  StoredChatMessageRecord,
  StoredChatSessionRecord,
  UISessionSummaryRecord,
} from "./historyTypes";
import { openBetterSqlite3Database } from "./betterSqlite3Runtime";
import { resolveHistoryStoragePaths } from "./historyStoragePaths";

type DatabaseHandle = InstanceType<typeof import("better-sqlite3")>;

interface HistorySqliteStoreOptions {
  filePath?: string;
}

interface ChatSessionRow {
  id: string;
  title: string;
  last_checkpoint_offset: number;
  last_profile_max_tokens: number | null;
  created_at: number;
  updated_at: number;
}

interface ChatSessionMessageRow {
  message_id: string;
  message_type: string;
  message_data_json: string;
}

interface UiSessionRow {
  id: string;
  title: string;
  updated_at: number;
  messages_count: number;
  last_message_preview: string;
}

interface UiSessionMessageRow {
  ui_message_id: string;
  backend_message_id: string | null;
  role: ChatMessage["role"];
  message_type: ChatMessage["type"];
  content: string;
  metadata_json: string | null;
  timestamp: number;
  streaming: number;
}

/**
 * One message as it will be written: the record plus the write-time position
 * and serialized body. These two are produced during save and never stored on
 * `StoredChatMessageRecord` (historyTypes.ts stays the public shape).
 */
interface DeltaMessageRow {
  id: string;
  type: string;
  position: number;
  dataJson: string;
}

/**
 * Per-message fingerprint, used ONLY to decide whether a row must be written.
 *
 * FULL serialized body — deliberately NOT `substr(json, 1, 200)`. A prefix
 * fingerprint MISSES a message whose content grows past the first 200
 * characters (exactly what streaming does to the last AI message): the prefix
 * is unchanged, so the row is skipped and the persisted history silently stays
 * STALE. Comparing the whole body is what makes "unchanged => skip" safe.
 *
 * The expensive half of the old freeze was JSON.parse (~1.5 s / 117 MB), and
 * that is still never paid here — this compares already-serialized text.
 */
function digestFor(message: { type: string; dataJson?: string | null }): string {
  return `${message.type}\u0000${message.dataJson ?? ""}`;
}

export class HistorySqliteStore {
  private readonly filePath: string;
  private readonly db: DatabaseHandle;

  constructor(options?: HistorySqliteStoreOptions) {
    this.filePath =
      options?.filePath || resolveHistoryStoragePaths().sqliteDbPath;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = openBetterSqlite3Database(this.filePath);
    HistorySqliteStore.initializeDatabase(this.db);
  }

  static initializeDatabase(db: DatabaseHandle): void {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("temp_store = MEMORY");
    db.pragma("cache_size = -32000");

    db.exec(`
      CREATE TABLE IF NOT EXISTS history_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        last_checkpoint_offset INTEGER NOT NULL DEFAULT 0,
        last_profile_max_tokens INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_session_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_data_json TEXT NOT NULL,
        PRIMARY KEY (session_id, position),
        UNIQUE (session_id, message_id),
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chat_session_messages_session_id
      ON chat_session_messages(session_id, position);

      CREATE TABLE IF NOT EXISTS ui_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        messages_count INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS ui_session_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        ui_message_id TEXT NOT NULL,
        backend_message_id TEXT,
        role TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        timestamp INTEGER NOT NULL,
        streaming INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, position),
        UNIQUE (ui_message_id),
        FOREIGN KEY (session_id) REFERENCES ui_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ui_session_messages_session_id
      ON ui_session_messages(session_id, position);

      CREATE INDEX IF NOT EXISTS idx_ui_session_messages_backend_message
      ON ui_session_messages(session_id, backend_message_id);

      CREATE INDEX IF NOT EXISTS idx_ui_sessions_updated_at
      ON ui_sessions(updated_at DESC);
    `);
  }

  static hasInitializedStore(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const db = openBetterSqlite3Database(filePath, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('history_meta', 'chat_sessions', 'ui_sessions')
           LIMIT 1`,
        )
        .get() as { name: string } | undefined;
      return Boolean(row?.name);
    } finally {
      db.close();
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM history_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO history_meta (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  loadChatSession(sessionId: string): StoredChatSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, title, last_checkpoint_offset, last_profile_max_tokens, created_at, updated_at
         FROM chat_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as ChatSessionRow | undefined;
    if (!row) {
      return null;
    }

    const messageRows = this.db
      .prepare(
        `SELECT message_id, message_type, message_data_json
         FROM chat_session_messages
         WHERE session_id = ?
         ORDER BY position ASC`,
      )
      .all(sessionId) as ChatSessionMessageRow[];

    return {
      id: row.id,
      title: row.title,
      messages: messageRows.map<StoredChatMessageRecord>((message) => ({
        id: message.message_id,
        type: message.message_type,
        data: JSON.parse(message.message_data_json),
      })),
      lastCheckpointOffset: row.last_checkpoint_offset,
      lastProfileMaxTokens: row.last_profile_max_tokens ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listChatSessionSummaries(): ChatSessionSummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT chat.id, chat.title, chat.updated_at, chat.created_at,
                chat.last_checkpoint_offset, chat.last_profile_max_tokens,
                COUNT(messages.message_id) AS messages_count
         FROM chat_sessions AS chat
         LEFT JOIN chat_session_messages AS messages
           ON messages.session_id = chat.id
         GROUP BY chat.id
         ORDER BY chat.updated_at DESC`,
      )
      .all() as Array<
      ChatSessionRow & {
        messages_count: number;
      }
    >;

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      messagesCount: row.messages_count,
      lastCheckpointOffset: row.last_checkpoint_offset,
      lastProfileMaxTokens: row.last_profile_max_tokens ?? undefined,
    }));
  }

  /**
   * Every session WITH all messages.
   *
   * FREEZE WARNING (v3.8.4): this JSON.parses every message of every session
   * in one synchronous burst — on this machine's 1.6 GB / multi-session store
   * that is seconds of blocked event loop (so the UI freezes, because
   * better-sqlite3 is synchronous and runs on the same thread).
   *
   * It is only acceptable for genuinely whole-store work. Callers that merely
   * need session *lists* must use `listChatSessionSummaries()` (COUNT only, no
   * message bodies) — see `searchChatHistoryBounded` in historySearch.ts,
   * which replaced the old bridge call to this method.
   */
  listChatSessions(): StoredChatSessionRecord[] {
    return this.listChatSessionSummaries()
      .map((summary) => this.loadChatSession(summary.id))
      .filter(
        (session): session is StoredChatSessionRecord => session !== null,
      );
  }

  /**
   * Session meta WITHOUT messages.
   *
   * Two fixed-cost hot-path bugs this closes:
   *
   *  1. `ChatHistoryService.saveSession` called `loadChatSession()` purely to
   *     learn `createdAt`. That JSON.parse'd the ENTIRE session — measured
   *     ~117 MB / ~1.5 s of parse for a 6k-message session — and threw every
   *     parsed message away, on every save.
   *  2. `AgentService_v2.trySaveSessionFromCheckpoint` called `loadSession()`
   *     for a default it never used, because `updateSessionFromMessages()`
   *     rebuilds `session.messages` from scratch. Dropping that call outright
   *     would have reset the session TITLE to "New Session" on every restore,
   *     so the title is read here too.
   */
  getChatSessionMeta(
    sessionId: string,
  ): { createdAt: number; title: string } | null {
    const row = this.db
      .prepare("SELECT created_at, title FROM chat_sessions WHERE id = ?")
      .get(sessionId) as { created_at: number; title: string } | undefined;
    return row ? { createdAt: row.created_at, title: row.title } : null;
  }

  /** Created-at scalar only — a single indexed row, never a message parse. */
  getChatSessionCreatedAt(sessionId: string): number | undefined {
    return this.getChatSessionMeta(sessionId)?.createdAt;
  }

  /**
   * Existing message bodies as RAW TEXT, ordered by position, WITHOUT parsing.
   *
   * The raw `message_data_json` is needed for a byte-exact comparison against
   * the newly serialized body. Deliberately NOT JSON.parse'd: the parse is the
   * expensive half of the freeze (~1.5 s / 117 MB measured) and is unnecessary
   * for an equality test.
   *
   * (An earlier revision compared only `substr(json, 1, 200)`. That was WRONG:
   * a message whose content grows past the first 200 characters — exactly what
   * streaming does to the last AI message — leaves the prefix untouched, so the
   * row would be skipped and the persisted history would silently stay STALE.
   * Full-text comparison is what makes "unchanged => skip" safe.)
   */
  loadSessionMessageState(
    sessionId: string,
  ): Array<{ id: string; type: string; position: number; jsonText: string }> {
    const rows = this.db
      .prepare(
        `SELECT message_id, message_type, position, message_data_json
         FROM chat_session_messages
         WHERE session_id = ?
         ORDER BY position ASC`,
      )
      .all(sessionId) as Array<{
      message_id: string;
      message_type: string;
      position: number;
      message_data_json: string | null;
    }>;
    return rows.map((row) => ({
      id: row.message_id,
      type: row.message_type,
      position: row.position,
      jsonText: row.message_data_json ?? "",
    }));
  }

  /**
   * Incremental write: touch only the rows that actually moved.
   *
   * The old path ran `DELETE ALL` + `INSERT ALL` on every save, rewriting the
   * whole session payload each time. Here, unchanged messages stay on disk
   * untouched; messages that are genuinely absent (compaction, rollback) are
   * removed individually.
   */
  applyChatSessionDelta(
    sessionId: string,
    desired: DeltaMessageRow[],
    existingDigests: Map<string, string>,
    writeAll: boolean,
  ): void {
    // Populated BEFORE the removal scan below — an empty set here would delete
    // every message in the session.
    const desiredIds = new Set<string>();
    for (const m of desired) {
      desiredIds.add(m.id);
    }

    const changed = writeAll
      ? desired
      : desired.filter((m) => existingDigests.get(m.id) !== digestFor(m));

    const toRemove: string[] = [];
    for (const id of existingDigests.keys()) {
      if (!desiredIds.has(id)) {
        toRemove.push(id);
      }
    }

    if (changed.length === 0 && toRemove.length === 0) {
      return;
    }

    const upsert = this.db.prepare(
      `INSERT INTO chat_session_messages (
         session_id, position, message_id, message_type, message_data_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, message_id) DO UPDATE SET
         position = excluded.position,
         message_type = excluded.message_type,
         message_data_json = excluded.message_data_json`,
    );
    const removeOne = this.db.prepare(
      "DELETE FROM chat_session_messages WHERE session_id = ? AND message_id = ?",
    );

    this.db.transaction(() => {
      for (const id of toRemove) {
        removeOne.run(sessionId, id);
      }
      for (const m of changed) {
        upsert.run(sessionId, m.position, m.id, m.type, m.dataJson);
      }
    })();
  }

  /**
   * Full positional rewrite. Positions are `PRIMARY KEY (session_id,
   * position)`, so an in-place UPDATE cannot express a reorder without a
   * transient collision — the order guard in saveChatSession routes here when
   * (and only when) the surviving ids changed relative order.
   *
   * Therefore this really does DELETE + INSERT rather than upsert. An
   * `ON CONFLICT(session_id, message_id)` upsert looks like it would work but
   * does NOT: reassigning `position` collides on the (session_id, position)
   * PRIMARY KEY against a row that has not moved yet, and that conflict is not
   * absorbed by an ON CONFLICT clause targeting a different key —
   *   SqliteError: UNIQUE constraint failed:
   *     chat_session_messages.session_id, chat_session_messages.position
   * Clearing first (inside the same transaction) sidesteps the ordering
   * problem entirely. This path is rare by design, so the rewrite is cheap
   * enough, and it matches the old DELETE-ALL/INSERT-ALL semantics exactly.
   */
  private replaceAllMessages(
    sessionId: string,
    desired: DeltaMessageRow[],
  ): void {
    const removeAll = this.db.prepare(
      "DELETE FROM chat_session_messages WHERE session_id = ?",
    );
    const insert = this.db.prepare(
      `INSERT INTO chat_session_messages (
         session_id, position, message_id, message_type, message_data_json
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      removeAll.run(sessionId);
      desired.forEach((m, index) => {
        insert.run(sessionId, index, m.id, m.type, m.dataJson);
      });
    })();
  }

  saveChatSession(session: StoredChatSessionRecord): void {
    const upsertSession = this.db.prepare(
      `INSERT INTO chat_sessions (
         id, title, last_checkpoint_offset, last_profile_max_tokens, created_at, updated_at
       ) VALUES (
         @id, @title, @lastCheckpointOffset, @lastProfileMaxTokens, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         last_checkpoint_offset = excluded.last_checkpoint_offset,
         last_profile_max_tokens = excluded.last_profile_max_tokens,
         updated_at = excluded.updated_at`,
    );

    // Session row FIRST, so re-inserting messages can never trip the
    // ON DELETE CASCADE foreign key (e.g. a compaction that emptied it).
    // DO UPDATE deliberately never assigns created_at: an existing row keeps
    // its original creation time no matter what the caller passes, which is
    // why no read-before-write is needed here.
    this.db.transaction(() => {
      upsertSession.run({
        id: session.id,
        title: session.title,
        lastCheckpointOffset: session.lastCheckpointOffset,
        lastProfileMaxTokens: session.lastProfileMaxTokens ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    })();

    // Bodies must be serialized to reach disk — that cost is inherent — but
    // only the rows that moved are written.
    const desired: DeltaMessageRow[] = session.messages.map(
      (message, index) => ({
        id: message.id,
        type: message.type,
        position: index,
        dataJson: JSON.stringify(message.data),
      }),
    );

    const existingState = this.loadSessionMessageState(session.id);
    const existingDigests = new Map<string, string>();
    for (const row of existingState) {
      // digestFor over the STORED text, so the comparison in
      // applyChatSessionDelta is byte-exact against digestFor(desired).
      existingDigests.set(
        row.id,
        digestFor({ type: row.type, dataJson: row.jsonText }),
      );
    }

    // Order guard: compare the SUBSEQUENCE of already-stored ids (in stored
    // position order) against the same ids in the desired order. If they
    // differ, a reorder happened and the position PRIMARY KEY cannot be fixed
    // by targeted UPDATEs — fall back to the full positional rewrite.
    // Note `storedOrder` must NOT be built by scanning existingDigests: that
    // map's order is whatever the SELECT returned.
    const storedOrder = existingState.map((row) => row.id);
    const desiredOrderOfStored: string[] = [];
    for (const m of desired) {
      if (existingDigests.has(m.id)) {
        desiredOrderOfStored.push(m.id);
      }
    }
    const reordered =
      storedOrder.length !== desiredOrderOfStored.length ||
      storedOrder.some((id, i) => id !== desiredOrderOfStored[i]);

    if (reordered) {
      this.replaceAllMessages(session.id, desired);
      return;
    }

    this.applyChatSessionDelta(session.id, desired, existingDigests, false);
  }

  deleteChatSessions(sessionIds: string[]): void {
    const ids = Array.from(
      new Set(sessionIds.filter((id) => id.trim().length > 0)),
    );
    if (ids.length === 0) return;
    const deleteSession = this.db.prepare(
      "DELETE FROM chat_sessions WHERE id = ?",
    );
    this.db.transaction(() => {
      ids.forEach((id) => deleteSession.run(id));
    })();
  }

  clearChatSessions(): void {
    this.db.prepare("DELETE FROM chat_sessions").run();
  }

  renameChatSession(
    sessionId: string,
    newTitle: string,
    updatedAt: number,
  ): void {
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET title = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(newTitle, updatedAt, sessionId);
  }

  loadUiSession(sessionId: string): UIChatSession | null {
    const row = this.db
      .prepare(
        `SELECT id, title, updated_at, messages_count, last_message_preview
         FROM ui_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as UiSessionRow | undefined;
    if (!row) {
      return null;
    }

    const messageRows = this.db
      .prepare(
        `SELECT ui_message_id, backend_message_id, role, message_type, content, metadata_json, timestamp, streaming
         FROM ui_session_messages
         WHERE session_id = ?
         ORDER BY position ASC`,
      )
      .all(sessionId) as UiSessionMessageRow[];

    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      messages: messageRows.map<ChatMessage>((message) => ({
        id: message.ui_message_id,
        backendMessageId: message.backend_message_id ?? undefined,
        role: message.role,
        type: message.message_type,
        content: message.content,
        metadata: message.metadata_json
          ? JSON.parse(message.metadata_json)
          : undefined,
        timestamp: message.timestamp,
        streaming: Boolean(message.streaming),
      })),
    };
  }

  listUiSessions(): UIChatSession[] {
    return this.listUiSessionSummaries()
      .map((summary) => this.loadUiSession(summary.id))
      .filter((session): session is UIChatSession => session !== null);
  }

  listUiSessionSummaries(): UISessionSummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, updated_at, messages_count, last_message_preview
         FROM ui_sessions
         ORDER BY updated_at DESC`,
      )
      .all() as UiSessionRow[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      messagesCount: row.messages_count,
      lastMessagePreview: row.last_message_preview,
    }));
  }

  saveUiSessions(
    entries: Array<{ session: UIChatSession; summary: UISessionSummaryRecord }>,
  ): void {
    if (entries.length === 0) {
      return;
    }
    const upsertSession = this.db.prepare(
      `INSERT INTO ui_sessions (
         id, title, updated_at, messages_count, last_message_preview
       ) VALUES (
         @id, @title, @updatedAt, @messagesCount, @lastMessagePreview
       )
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         messages_count = excluded.messages_count,
         last_message_preview = excluded.last_message_preview`,
    );
    const deleteMessages = this.db.prepare(
      "DELETE FROM ui_session_messages WHERE session_id = ?",
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO ui_session_messages (
         session_id, position, ui_message_id, backend_message_id, role, message_type, content, metadata_json, timestamp, streaming
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      entries.forEach(({ session, summary }) => {
        upsertSession.run({
          id: session.id,
          title: summary.title,
          updatedAt: summary.updatedAt,
          messagesCount: summary.messagesCount,
          lastMessagePreview: summary.lastMessagePreview,
        });
        deleteMessages.run(session.id);
        session.messages.forEach((message, index) => {
          insertMessage.run(
            session.id,
            index,
            message.id,
            message.backendMessageId ?? null,
            message.role,
            message.type,
            message.content,
            message.metadata ? JSON.stringify(message.metadata) : null,
            message.timestamp,
            message.streaming ? 1 : 0,
          );
        });
      });
    })();
  }

  /**
   * v3.4.1: append only the NEW messages for a session instead of rewriting
   * the whole session. saveUiSessions() deletes every row and re-inserts the
   * entire message list — on a long session that is a large synchronous
   * better-sqlite3 transaction on the main event loop, which is the
   * spinning-wheel freeze. This method appends from a given position in one
   * small transaction, so a debounced flush costs O(new messages), not
   * O(all messages).
   *
   * v3.4.3: this is a TRUNCATE-AND-APPEND from fromPosition — rows at
   * position >= fromPosition are deleted before the slice is inserted. The
   * caller always passes fromPosition such that messages[fromPosition..] is
   * the authoritative content, so this is what makes a rollback (or any
   * shrink) expressible on the incremental path: without the delete, the
   * old tail rows would survive the flush and resurrect on reload.
   *
   * Returns the number of rows appended.
   */
  appendUiSessionMessages(
    sessionId: string,
    messages: ChatMessage[],
    fromPosition: number,
    summary?: UISessionSummaryRecord,
  ): number {
    if (messages.length === 0 || fromPosition >= messages.length) {
      return 0;
    }
    const upsertSession = this.db.prepare(
      `INSERT INTO ui_sessions (
         id, title, updated_at, messages_count, last_message_preview
       ) VALUES (
         @id, @title, @updatedAt, @messagesCount, @lastMessagePreview
       )
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         messages_count = excluded.messages_count,
         last_message_preview = excluded.last_message_preview`,
    );
    const insertMessage = this.db.prepare(
      `INSERT OR REPLACE INTO ui_session_messages (
         session_id, position, ui_message_id, backend_message_id, role, message_type, content, metadata_json, timestamp, streaming
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // v3.4.3: positions >= fromPosition hold the authoritative content, so
    // drop any stale rows at or beyond it. For a plain append this deletes
    // nothing; after a rollback it removes the truncated tail, which is the
    // only way the incremental path can express a shrink.
    const truncateFrom = this.db.prepare(
      "DELETE FROM ui_session_messages WHERE session_id = ? AND position >= ?",
    );
    const slice = messages.slice(fromPosition);
    this.db.transaction(() => {
      // The messages table has a FK to ui_sessions — always upsert the
      // parent row, even without a summary, or the insert fails.
      if (summary) {
        upsertSession.run({
          id: sessionId,
          title: summary.title,
          updatedAt: summary.updatedAt,
          messagesCount: summary.messagesCount,
          lastMessagePreview: summary.lastMessagePreview,
        });
      } else {
        const existing = this.db
          .prepare("SELECT title, updated_at FROM ui_sessions WHERE id = ?")
          .get(sessionId) as { title: string; updated_at: number } | undefined;
        // v3.4.3: the count is the FULL message list length, not
        // fromPosition + slice.length — that expression happened to be
        // equal for a pure append but was wrong whenever the caller had
        // already truncated rows (rollback/remove), double-counting them.
        upsertSession.run({
          id: sessionId,
          title: existing?.title ?? "New Chat",
          updatedAt: Date.now(),
          messagesCount: messages.length,
          lastMessagePreview: slice[slice.length - 1]?.content?.slice(0, 200) ?? "",
        });
      }
      // v3.4.3: run the truncate inside the same transaction as the inserts
      // so the on-disk tail can never disagree with the in-memory slice.
      truncateFrom.run(sessionId, fromPosition);
      for (let i = 0; i < slice.length; i++) {
        const message = slice[i];
        insertMessage.run(
          sessionId,
          fromPosition + i,
          message.id,
          message.backendMessageId ?? null,
          message.role,
          message.type,
          message.content,
          message.metadata ? JSON.stringify(message.metadata) : null,
          message.timestamp,
          message.streaming ? 1 : 0,
        );
      }
    })();
    return slice.length;
  }

  /** v3.4.1: how many messages are already persisted for a session. */
  countUiSessionMessages(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM ui_session_messages WHERE session_id = ?")
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  deleteUiSessions(sessionIds: string[]): void {
    const ids = Array.from(
      new Set(sessionIds.filter((id) => id.trim().length > 0)),
    );
    if (ids.length === 0) return;
    const deleteSession = this.db.prepare(
      "DELETE FROM ui_sessions WHERE id = ?",
    );
    this.db.transaction(() => {
      ids.forEach((id) => deleteSession.run(id));
    })();
  }

  renameUiSession(
    sessionId: string,
    newTitle: string,
    updatedAt: number,
  ): void {
    this.db
      .prepare(
        `UPDATE ui_sessions
         SET title = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(newTitle, updatedAt, sessionId);
  }
}

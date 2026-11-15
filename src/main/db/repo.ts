import { randomUUID } from "node:crypto";
import type { Citation, ErrorCode } from "@shared/ipc-contract";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AppError } from "../errors.js";
import type { DrizzleDb } from "./client.js";
import { parseCitations } from "./repo-knowledge.js";
import { generations, type Message, messages, settings, type Thread, threads } from "./schema.js";

/**
 * Every SQL statement the inference layer is allowed to make.
 *
 * Drizzle is synchronous on better-sqlite3, so these are plain functions rather
 * than promises: the only async boundary in a turn is the network, and pretending
 * otherwise here would make it harder to see where the turn actually waits.
 *
 * All timestamps are written explicitly where "now" matters. The columns have SQL
 * defaults, but a default only fires on insert — `touchThread` needs its own
 * `updated_at`, and relying on `strftime` for `ended_at` would leave the terminal
 * instant to the database's clock rather than the process's.
 */

export interface CreateThreadInput {
  id: string;
  title?: string;
  /** D6: the project the new thread is filed under, if any. */
  projectId?: string | null;
  /** D6: the assistant it was first sent with, if any. */
  assistantId?: string | null;
}

export function createThread(db: DrizzleDb, input: CreateThreadInput): void {
  db.insert(threads)
    .values({
      id: input.id,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.assistantId === undefined ? {} : { assistantId: input.assistantId }),
    })
    .run();
}

/**
 * Files an existing thread under a project, or records the assistant it was just sent
 * with. Only the fields provided are written, so setting an assistant cannot silently
 * move a thread out of its project.
 *
 * `updated_at` is deliberately untouched: `chat.send` already touches the thread, and a
 * second write here would be a second source of the same edit.
 */
export function assignThread(
  db: DrizzleDb,
  threadId: string,
  patch: { projectId?: string | null; assistantId?: string | null },
): void {
  if (patch.projectId === undefined && patch.assistantId === undefined) return;

  db.update(threads)
    .set({
      ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
      ...(patch.assistantId === undefined ? {} : { assistantId: patch.assistantId }),
    })
    .where(eq(threads.id, threadId))
    .run();
}

/** Keeps a thread at the top of the sidebar when a message lands in it. */
export function touchThread(db: DrizzleDb, threadId: string): void {
  db.update(threads)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(threads.id, threadId))
    .run();
}

export interface InsertMessageInput {
  id: string;
  threadId: string;
  parentId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  model?: string | null;
  /**
   * The message this row regenerates, when it is a variant rather than a fresh
   * turn. Sibling grouping itself is by `parent_id`; this is only the pointer back
   * to the specific message the user asked to replace.
   */
  variantOf?: string | null;
  /**
   * D8: the chunks this answer was grounded on. Written once, when the row is created —
   * the citation list is a fact about the turn, not something a later write revises.
   */
  citations?: readonly Citation[] | undefined;
}

export function insertMessage(db: DrizzleDb, input: InsertMessageInput): void {
  db.insert(messages)
    .values({
      id: input.id,
      threadId: input.threadId,
      parentId: input.parentId,
      role: input.role,
      text: input.text,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.variantOf === undefined ? {} : { variantOf: input.variantOf }),
      ...(input.citations === undefined || input.citations.length === 0
        ? {}
        : { citationsJson: JSON.stringify(input.citations) }),
    })
    .run();
}

/**
 * Writes the accumulated assistant text. Called on a checkpoint and once when the
 * turn ends, so the row is the durable answer whenever the process stops.
 */
export function updateMessageText(db: DrizzleDb, messageId: string, text: string): void {
  db.update(messages).set({ text }).where(eq(messages.id, messageId)).run();
}

export interface InsertGenerationInput {
  id: string;
  threadId: string;
  messageId: string;
  model: string;
}

export function insertGeneration(db: DrizzleDb, input: InsertGenerationInput): void {
  db.insert(generations)
    .values({
      id: input.id,
      threadId: input.threadId,
      messageId: input.messageId,
      model: input.model,
    })
    .run();
}

export interface GenerationOutcome {
  /**
   * Null means the turn ended without the model finishing it: a user stop, or a
   * failure. `stop` is reserved for the model's own end-of-answer signal.
   */
  finishReason: string | null;
  errorCode: ErrorCode | null;
  promptTokens?: number;
  completionTokens?: number;
  costMicrocents?: number;
}

/** The terminal write. After this the generation is no longer resumable. */
export function finishGeneration(
  db: DrizzleDb,
  generationId: string,
  outcome: GenerationOutcome,
): void {
  db.update(generations)
    .set({
      finishReason: outcome.finishReason,
      errorCode: outcome.errorCode,
      promptTokens: outcome.promptTokens ?? 0,
      completionTokens: outcome.completionTokens ?? 0,
      costMicrocents: outcome.costMicrocents ?? 0,
      endedAt: new Date().toISOString(),
    })
    .where(eq(generations.id, generationId))
    .run();
}

export interface ThreadWithMessages {
  thread: Thread;
  messages: Message[];
}

/** One thread row, or null. Cheap enough to call on every turn: it is a primary-key read. */
export function getThread(db: DrizzleDb, threadId: string): Thread | null {
  const row = db.select().from(threads).where(eq(threads.id, threadId)).get();
  return row ?? null;
}

/**
 * The thread and its live messages, oldest first.
 *
 * Ordered by `created_at` with `rowid` as the tiebreaker: two inserts in the same
 * millisecond are the normal case here (a user message and the empty assistant
 * reply are written back to back), and `created_at` alone would leave their order
 * to the query planner. `rowid` is monotonic for inserts, so it is the insertion
 * order the tree was built in.
 */
export function getThreadWithMessages(db: DrizzleDb, threadId: string): ThreadWithMessages | null {
  const thread = db.select().from(threads).where(eq(threads.id, threadId)).get();
  if (thread === undefined) return null;

  const rows = db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt), sql`"messages"."rowid"`)
    .all();

  return { thread, messages: rows };
}

/* ------------------------------------------------------------ D2: the list */

export interface ListThreadsInput {
  /** FTS5 term; empty or undefined means "everything". */
  query?: string | undefined;
  /** D6: only threads filed under this project; absent means "every project". */
  projectId?: string | undefined;
  limit: number;
  offset: number;
  includeArchived: boolean;
}

/** Row-for-row the `threads.list` item shape, so the handler is a pass-through. */
export interface ThreadListItem {
  id: string;
  title: string;
  updatedAt: string;
  pinned: boolean;
  archivedAt: string | null;
  messageCount: number;
  projectId: string | null;
  snippet: string | null;
}

export interface ListThreadsResult {
  items: ThreadListItem[];
  total: number;
}

interface ThreadListRow {
  id: string;
  title: string;
  updated_at: string;
  pinned: number;
  archived_at: string | null;
  message_count: number;
  project_id: string | null;
  snippet: string | null;
}

/**
 * Turns a user's search box into an FTS5 query that cannot be an operator.
 *
 * FTS5's MATCH language is a parser: `jumps AND` and a stray quote are syntax
 * errors, and the query string comes from a text field, so passing it through is
 * a crash waiting for punctuation. Each whitespace-separated token is wrapped in
 * double quotes (with embedded quotes doubled, which is how FTS5 escapes them) and
 * the phrases are joined by whitespace — FTS5's implicit AND. A token with no
 * searchable characters becomes an empty phrase, which matches nothing rather than
 * throwing.
 */
function toFtsMatch(term: string): string {
  return term
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "")
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

/**
 * The sidebar read: one page of threads, plus the total the page was cut from.
 *
 * Both halves are SQL over the same predicate — the `items.length` is not the
 * total, and nothing is filtered in JavaScript. The search branch joins the FTS5
 * index to `messages` to `threads` and ranks by `bm25()`; the plain branch is the
 * pinned-first recency order the sidebar uses when there is no query.
 *
 * `bm25()` and `snippet()` are FTS5 auxiliary functions and SQLite only allows them
 * where the virtual table is queried directly — not under `GROUP BY`, and not in a
 * correlated subquery. That is why the search branch computes both in a CTE over
 * the FTS table first and only then reduces one row per thread: the outer query
 * sees them as ordinary columns.
 */
export function listThreads(db: DrizzleDb, input: ListThreadsInput): ListThreadsResult {
  const includeArchived = input.includeArchived ? 1 : 0;
  const term = input.query?.trim() ?? "";
  /**
   * D6's project filter, as one bound parameter used twice.
   *
   * Null means "every project", and the predicate says so in SQL rather than in a
   * second copy of each query: `(? IS NULL OR t.project_id = ?)` is the same shape for
   * the plain list, the search branch and both counts, so a filtered sidebar cannot
   * disagree with its own total.
   */
  const projectFilter = input.projectId ?? null;

  if (term === "") {
    const items = db
      .all<ThreadListRow>(sql`
        SELECT
          t.id            AS id,
          t.title         AS title,
          t.updated_at    AS updated_at,
          t.pinned        AS pinned,
          t.archived_at   AS archived_at,
          t.project_id    AS project_id,
          (SELECT COUNT(*) FROM messages AS mc
            WHERE mc.thread_id = t.id AND mc.deleted_at IS NULL) AS message_count,
          NULL            AS snippet
        FROM threads AS t
        WHERE t.deleted_at IS NULL
          AND (${includeArchived} = 1 OR t.archived_at IS NULL)
          AND (${projectFilter} IS NULL OR t.project_id = ${projectFilter})
        ORDER BY t.pinned DESC, t.updated_at DESC
        LIMIT ${input.limit} OFFSET ${input.offset}
      `)
      .map(toThreadListItem);

    const total = db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n
      FROM threads AS t
      WHERE t.deleted_at IS NULL
        AND (${includeArchived} = 1 OR t.archived_at IS NULL)
        AND (${projectFilter} IS NULL OR t.project_id = ${projectFilter})
    `);

    return { items, total: total?.n ?? 0 };
  }

  const match = toFtsMatch(term);

  const items = db
    .all<ThreadListRow>(sql`
      WITH hits AS (
        SELECT
          m.thread_id                        AS thread_id,
          bm25(messages_fts)                 AS rank,
          snippet(messages_fts, 1, '[', ']', '…', 12) AS snippet,
          m.id                               AS message_id
        FROM messages_fts
        JOIN messages AS m ON m.id = messages_fts.message_id
        JOIN threads  AS t ON t.id = m.thread_id
        WHERE messages_fts MATCH ${match}
          AND m.deleted_at IS NULL
          AND t.deleted_at IS NULL
          AND (${includeArchived} = 1 OR t.archived_at IS NULL)
          AND (${projectFilter} IS NULL OR t.project_id = ${projectFilter})
      ),
      best AS (
        SELECT
          thread_id,
          rank,
          snippet,
          ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY rank ASC, message_id ASC) AS rn
        FROM hits
      )
      SELECT
        t.id            AS id,
        t.title         AS title,
        t.updated_at    AS updated_at,
        t.pinned        AS pinned,
        t.archived_at   AS archived_at,
        t.project_id    AS project_id,
        (SELECT COUNT(*) FROM messages AS mc
          WHERE mc.thread_id = t.id AND mc.deleted_at IS NULL) AS message_count,
        b.snippet       AS snippet
      FROM best AS b
      JOIN threads AS t ON t.id = b.thread_id
      WHERE b.rn = 1
      ORDER BY b.rank ASC, t.updated_at DESC
      LIMIT ${input.limit} OFFSET ${input.offset}
    `)
    .map(toThreadListItem);

  const total = db.get<{ n: number }>(sql`
    WITH hits AS (
      SELECT m.thread_id AS thread_id
      FROM messages_fts
      JOIN messages AS m ON m.id = messages_fts.message_id
      JOIN threads  AS t ON t.id = m.thread_id
      WHERE messages_fts MATCH ${match}
        AND m.deleted_at IS NULL
        AND t.deleted_at IS NULL
        AND (${includeArchived} = 1 OR t.archived_at IS NULL)
        AND (${projectFilter} IS NULL OR t.project_id = ${projectFilter})
    )
    SELECT COUNT(*) AS n
    FROM (SELECT thread_id FROM hits GROUP BY thread_id)
  `);

  return { items, total: total?.n ?? 0 };
}

function toThreadListItem(row: ThreadListRow): ThreadListItem {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    // SQLite has no boolean: the column is 0/1 and the contract says boolean.
    pinned: row.pinned !== 0,
    archivedAt: row.archived_at,
    messageCount: row.message_count,
    projectId: row.project_id,
    snippet: row.snippet,
  };
}

/* ---------------------------------------------------------- D2: the writes */

export interface UpdateThreadInput {
  threadId: string;
  title?: string | undefined;
  pinned?: boolean | undefined;
  archived?: boolean | undefined;
}

/**
 * Renames, pins, or archives. Each field is independent; `updated_at` always moves
 * because every one of these is a user edit and the sidebar's order is by it.
 *
 * `.returning()` rather than a preceding SELECT: the "did this row exist" question
 * is answered by the write itself, so a thread deleted between the two statements
 * cannot be updated behind its own tombstone.
 */
export function updateThread(db: DrizzleDb, input: UpdateThreadInput): void {
  const patch: Partial<Pick<Thread, "title" | "pinned" | "archivedAt" | "updatedAt">> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.title !== undefined) patch.title = input.title;
  if (input.pinned !== undefined) patch.pinned = input.pinned;
  if (input.archived !== undefined)
    patch.archivedAt = input.archived ? new Date().toISOString() : null;

  const updated = db
    .update(threads)
    .set(patch)
    .where(and(eq(threads.id, input.threadId), isNull(threads.deletedAt)))
    .returning({ id: threads.id })
    .all();

  if (updated.length === 0) {
    throw new AppError("NOT_FOUND", "thread not found", { details: { threadId: input.threadId } });
  }
}

/**
 * The tombstone. Rows are never physically removed: `messages` and `generations`
 * cascade off `threads`, so a hard delete would take the generation history with it,
 * and a thread the user "deleted" a second ago is exactly what they may want back.
 *
 * An already-deleted thread is NOT_FOUND, not a silent success: the caller asked to
 * delete something that is not there any more, and the guard is in the WHERE clause
 * so two concurrent deletes cannot both believe they won.
 */
export function softDeleteThread(db: DrizzleDb, threadId: string): void {
  const deleted = db
    .update(threads)
    .set({ deletedAt: new Date().toISOString() })
    .where(and(eq(threads.id, threadId), isNull(threads.deletedAt)))
    .returning({ id: threads.id })
    .all();

  if (deleted.length === 0) {
    throw new AppError("NOT_FOUND", "thread not found", { details: { threadId } });
  }
}

/* --------------------------------------------------------- D3: the variant */

export interface RegenerateResult {
  threadId: string;
  /** The message being answered again — the new assistant row's parent. */
  userMessageId: string;
  assistantMessageId: string;
  generationId: string;
}

/**
 * Regenerates an assistant message by adding a sibling under the same parent.
 *
 * Branching is native here (schema v1): the old answer is not overwritten, it
 * becomes one variant and the new row becomes another, so "2 / 3" has something to
 * count and the user can go back. That is also why this is a *new* message with a
 * *new* generation row rather than a rewrite: the previous answer's usage and error
 * code are evidence, not scratch space.
 *
 * The caller starts the stream; this only makes the rows durable first, in the same
 * order `chat.send` uses — message, generation, thread touch — so a crash between
 * the two leaves a resumable turn rather than a message with no generation.
 *
 * A missing id, a non-assistant row, or an assistant row with no parent (which
 * `chat.send` never writes) is BAD_REQUEST: the request named a message this
 * operation has no meaning for.
 */
export function regenerate(db: DrizzleDb, messageId: string): RegenerateResult {
  const original = getMessage(db, messageId);
  if (original === null || original.deletedAt !== null) {
    throw new AppError("BAD_REQUEST", "message not found", { details: { messageId } });
  }
  if (original.role !== "assistant") {
    throw new AppError("BAD_REQUEST", "only an assistant message can be regenerated", {
      details: { messageId, role: original.role },
    });
  }
  if (original.parentId === null) {
    throw new AppError("BAD_REQUEST", "assistant message has no parent to answer", {
      details: { messageId },
    });
  }

  const parentId = original.parentId;
  const threadId = original.threadId;
  const assistantMessageId = randomUUID();
  const generationId = randomUUID();

  db.transaction((tx) => {
    insertMessage(tx, {
      id: assistantMessageId,
      threadId,
      parentId,
      role: "assistant",
      text: "",
      model: original.model,
      variantOf: original.id,
    });
    insertGeneration(tx, {
      id: generationId,
      threadId,
      messageId: assistantMessageId,
      // `messages.model` is nullable and `generations.model` is not. A regenerated
      // turn runs with the model of the answer it replaces; an empty string is the
      // honest record of "this row never carried one" rather than inventing a name.
      model: original.model ?? "",
    });
    // The new answer is what the user is looking at, so it becomes the active leaf:
    // the next turn hangs under it, not under the variant it just superseded.
    tx.update(threads)
      .set({ activeLeafId: assistantMessageId })
      .where(eq(threads.id, threadId))
      .run();
    touchThread(tx, threadId);
  });

  return { threadId, userMessageId: parentId, assistantMessageId, generationId };
}

/**
 * Selects which variant the thread shows.
 *
 * The message has to be live and belong to the thread: a leaf id from another
 * conversation would silently jump the user into somebody else's history, and a
 * soft-deleted row would point the path at a message the read filters out anyway.
 *
 * `updated_at` is deliberately untouched. Switching which branch you are reading is
 * a view action; moving the thread to the top of the sidebar for it would make the
 * list reorder itself under the user's cursor.
 */
export function setActiveVariant(db: DrizzleDb, threadId: string, messageId: string): void {
  const thread = db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, threadId), isNull(threads.deletedAt)))
    .get();

  if (thread === undefined) {
    throw new AppError("NOT_FOUND", "thread not found", { details: { threadId } });
  }

  const message = getMessage(db, messageId);
  if (message === null || message.deletedAt !== null || message.threadId !== threadId) {
    throw new AppError("NOT_FOUND", "message not found in thread", {
      details: { threadId, messageId },
    });
  }

  db.update(threads).set({ activeLeafId: messageId }).where(eq(threads.id, threadId)).run();
}

/* ---------------------------------------------------------- D3: the tree --- */

export function getMessage(db: DrizzleDb, messageId: string): Message | null {
  const row = db.select().from(messages).where(eq(messages.id, messageId)).get();
  return row ?? null;
}

/**
 * Root -> leaf for the thread's active variant.
 *
 * Resolution: an explicitly selected leaf if it is still live and in this thread,
 * otherwise the newest live message. Walk `parent_id` upwards, then reverse; the
 * walk stops on a repeated id so a corrupt parent cycle degrades to a truncated path
 * instead of hanging the main process.
 */
export function resolveActivePath(loaded: ThreadWithMessages): Message[] {
  const byId = new Map(loaded.messages.map((message) => [message.id, message]));
  const stored = loaded.thread.activeLeafId;
  const selected = stored === null ? undefined : byId.get(stored);
  const leaf = selected ?? loaded.messages.at(-1);
  return leaf === undefined ? [] : pathTo(byId, leaf);
}

/** Root -> `leafId` inclusive, the prompt an answer to that message was given. */
export function resolveAncestorPath(loaded: ThreadWithMessages, leafId: string): Message[] {
  const byId = new Map(loaded.messages.map((message) => [message.id, message]));
  const leaf = byId.get(leafId);
  return leaf === undefined ? [] : pathTo(byId, leaf);
}

function pathTo(byId: Map<string, Message>, leaf: Message): Message[] {
  const path: Message[] = [];
  const seen = new Set<string>();
  let current: Message | undefined = leaf;

  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }

  return path.reverse();
}

export function getActivePath(db: DrizzleDb, threadId: string): Message[] {
  const loaded = getThreadWithMessages(db, threadId);
  return loaded === null ? [] : resolveActivePath(loaded);
}

export function getAncestorPath(db: DrizzleDb, threadId: string, leafId: string): Message[] {
  const loaded = getThreadWithMessages(db, threadId);
  return loaded === null ? [] : resolveAncestorPath(loaded, leafId);
}

export interface GenerationUsage {
  promptTokens: number;
  completionTokens: number;
  costMicrocents: number;
}

/** One message as the tree read reports it, before the contract's boundary types. */
export interface ThreadMessageNode {
  id: string;
  role: Message["role"];
  text: string;
  createdAt: string;
  parentId: string | null;
  variantOf: string | null;
  /**
   * Every live sibling that shares this message's parent, oldest first, **including
   * this message**. The UI needs the whole set to place itself ("2 / 3") and the
   * count is the same number either way, so self-inclusion saves it a merge.
   */
  variants: string[];
  generationId: string | null;
  errorCode: string | null;
  usage: GenerationUsage | null;
  /**
   * D8: what this answer was grounded on, in marker order. Empty when the turn used no
   * knowledge — the boundary leaves it out in that case, as it does for attachments.
   */
  citations: Citation[];
}

export interface ThreadTree {
  thread: Thread;
  messages: ThreadMessageNode[];
  /**
   * The selected leaf, or null when none was selected or the stored one is gone.
   * Null is not "no messages" — it is "follow the newest leaf".
   */
  activeLeafId: string | null;
}

/**
 * The `chat.thread` read, now with tree metadata.
 *
 * Sibling groups are built from the thread's own messages, which are already loaded
 * in insertion order, so they inherit that order: `created_at` with `rowid` as the
 * tiebreaker. Two variants created in the same millisecond are the normal case (a
 * regenerate writes the message and its generation back to back), which is why the
 * tiebreaker is not optional here.
 */
export function getThreadTree(db: DrizzleDb, threadId: string): ThreadTree | null {
  const loaded = getThreadWithMessages(db, threadId);
  if (loaded === null) return null;

  const generationsByMessage = readGenerations(db, threadId);
  const siblings = new Map<string | null, string[]>();
  for (const message of loaded.messages) {
    const group = siblings.get(message.parentId);
    if (group === undefined) siblings.set(message.parentId, [message.id]);
    else group.push(message.id);
  }

  const liveIds = new Set(loaded.messages.map((message) => message.id));
  const stored = loaded.thread.activeLeafId;

  return {
    thread: loaded.thread,
    activeLeafId: stored !== null && liveIds.has(stored) ? stored : null,
    messages: loaded.messages.map((message) => {
      const generation = generationsByMessage.get(message.id);
      return {
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        parentId: message.parentId,
        variantOf: message.variantOf,
        variants: siblings.get(message.parentId) ?? [message.id],
        generationId: generation?.id ?? null,
        errorCode: generation?.errorCode ?? null,
        usage:
          generation === undefined
            ? null
            : {
                promptTokens: generation.promptTokens,
                completionTokens: generation.completionTokens,
                costMicrocents: generation.costMicrocents,
              },
        citations: parseCitations(message.citationsJson),
      };
    }),
  };
}

interface GenerationForMessage {
  id: string;
  errorCode: string | null;
  promptTokens: number;
  completionTokens: number;
  costMicrocents: number;
}

/**
 * One read for the whole thread rather than one per message. If a message somehow
 * carries more than one generation row, the last one written wins — it is the one
 * that produced the text on screen.
 */
function readGenerations(db: DrizzleDb, threadId: string): Map<string, GenerationForMessage> {
  const rows = db
    .select({
      id: generations.id,
      messageId: generations.messageId,
      errorCode: generations.errorCode,
      promptTokens: generations.promptTokens,
      completionTokens: generations.completionTokens,
      costMicrocents: generations.costMicrocents,
    })
    .from(generations)
    .where(eq(generations.threadId, threadId))
    .orderBy(asc(generations.startedAt), sql`"generations"."rowid"`)
    .all();

  const byMessage = new Map<string, GenerationForMessage>();
  for (const row of rows) {
    if (row.messageId === null) continue;
    byMessage.set(row.messageId, {
      id: row.id,
      errorCode: row.errorCode,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      costMicrocents: row.costMicrocents,
    });
  }
  return byMessage;
}

/* ------------------------------------------------------- P0: the settings */

/**
 * The three keys the provider settings screen owns.
 *
 * Column names, not TypeScript names, because they are the durable half: a rename
 * here is a data migration for every user who already saved a URL.
 */
const BASE_URL_KEY = "base_url";
const DEFAULT_MODEL_KEY = "default_model";
/** D8: the model retrieval embeds with. Blank/absent means the default, not "no model". */
const EMBEDDING_MODEL_KEY = "embedding_model";

export interface StoredSettings {
  /** Null means "never configured" — the resolver decides what that implies. */
  baseUrl: string | null;
  defaultModel: string | null;
  /**
   * D8: never null. A knowledge base needs an embedding model to answer at all, and "not
   * configured" is not a state search can be in — the caller applies the default.
   */
  embeddingModel: string | null;
}

/**
 * All three keys in one read.
 *
 * The filter is explicit rather than `SELECT *`: a future setting that belongs to
 * another screen must not appear in this response, and the contract has no field
 * to put it in.
 */
export function getSettings(db: DrizzleDb): StoredSettings {
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [BASE_URL_KEY, DEFAULT_MODEL_KEY, EMBEDDING_MODEL_KEY]))
    .all();

  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    baseUrl: byKey.get(BASE_URL_KEY) ?? null,
    defaultModel: byKey.get(DEFAULT_MODEL_KEY) ?? null,
    embeddingModel: byKey.get(EMBEDDING_MODEL_KEY) ?? null,
  };
}

/**
 * What the caller asked to change. `undefined` means "leave it alone"; `null`
 * means "clear it" — the two are different requests, and the contract keeps them
 * distinct by making a *missing* field the only way to say nothing at all.
 */
export interface SettingsPatch {
  baseUrl?: string | null | undefined;
  defaultModel?: string | null | undefined;
  embeddingModel?: string | null | undefined;
}

/**
 * Writes only the keys that were provided.
 *
 * One transaction for the whole patch: a settings screen that changes the base URL
 * and the default model together must not be able to save half of it, and a partial
 * write is exactly what a crash between two statements leaves behind.
 *
 * Upsert, not insert: `ON CONFLICT(key) DO UPDATE` keeps the row count at one per
 * key whatever the order of edits was, and `updated_at` moves with every write.
 *
 * A blank value is a clear rather than a stored empty string — an empty base URL in
 * the row would read back as "configured" to the settings screen while the resolver
 * would treat it as unset, and the two would disagree about what the user sees.
 */
export function setSettings(db: DrizzleDb, patch: SettingsPatch): StoredSettings {
  const writes: { key: string; value: string }[] = [];
  const clears: string[] = [];

  const absorb = (key: string, raw: string | null | undefined): void => {
    if (raw === undefined) return;
    const value = raw === null ? "" : raw.trim();
    if (value === "") clears.push(key);
    else writes.push({ key, value });
  };

  absorb(BASE_URL_KEY, patch.baseUrl);
  absorb(DEFAULT_MODEL_KEY, patch.defaultModel);
  absorb(EMBEDDING_MODEL_KEY, patch.embeddingModel);

  db.transaction((tx) => {
    if (writes.length > 0) {
      tx.insert(settings)
        .values(writes)
        .onConflictDoUpdate({
          target: settings.key,
          // `excluded` is the row this statement wanted to insert, so each key
          // updates to its own new value in a single round trip.
          set: { value: sql`excluded."value"`, updatedAt: new Date().toISOString() },
        })
        .run();
    }

    if (clears.length > 0) {
      tx.delete(settings).where(inArray(settings.key, clears)).run();
    }
  });

  return getSettings(db);
}

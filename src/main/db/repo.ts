import type { ErrorCode } from "@shared/ipc-contract";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import { generations, type Message, messages, type Thread, threads } from "./schema.js";

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
}

export function createThread(db: DrizzleDb, input: CreateThreadInput): void {
  db.insert(threads)
    .values({
      id: input.id,
      ...(input.title === undefined ? {} : { title: input.title }),
    })
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

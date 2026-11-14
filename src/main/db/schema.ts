import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Schema v1. Local-first: everything lives here, nothing is authoritative in the cloud.
 *
 * Branching is native: `messages.parent_id` is a tree, not a list. Regenerating a
 * message creates a sibling under the same parent; forking reparents a subtree.
 */
export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("New thread"),
    projectId: text("project_id"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("threads_updated_idx").on(t.updatedAt),
    index("threads_project_idx").on(t.projectId),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** Self-referential tree: null means a root of the thread. */
    parentId: text("parent_id"),
    role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
    /** Denormalised plain text for FTS; the structured form lives in content_blocks. */
    text: text("text").notNull().default(""),
    model: text("model"),
    variantOf: text("variant_of"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("messages_thread_idx").on(t.threadId, t.createdAt),
    index("messages_parent_idx").on(t.parentId),
  ],
);

export const contentBlocks = sqliteTable(
  "content_blocks",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind", {
      enum: ["text", "reasoning", "image", "document", "tool_call", "tool_result"],
    }).notNull(),
    /** JSON payload, shape determined by `kind`. Validated in the service layer. */
    data: text("data").notNull(),
  },
  (t) => [index("blocks_message_idx").on(t.messageId, t.ordinal)],
);

export const generations = sqliteTable(
  "generations",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    /** Cost in millionths of a cent — integer, never a float. */
    costMicrocents: integer("cost_microcents").notNull().default(0),
    finishReason: text("finish_reason"),
    errorCode: text("error_code"),
    startedAt: text("started_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
  },
  (t) => [index("generations_thread_idx").on(t.threadId)],
);

export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ContentBlock = typeof contentBlocks.$inferSelect;
export type Generation = typeof generations.$inferSelect;

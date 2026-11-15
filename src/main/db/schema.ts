import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Schema v7. Local-first: everything lives here, nothing is authoritative in the cloud.
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
    /**
     * Migration 5. The assistant this thread was last sent with. No foreign key: an
     * archived assistant must not make a thread unreadable, and the id is only read to
     * re-apply a system prompt on the next turn.
     */
    assistantId: text("assistant_id"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    archivedAt: text("archived_at"),
    /**
     * Migration 2. The leaf whose ancestor path is the visible conversation;
     * null means "follow the newest leaf". See `migrations.ts` for why it carries
     * no foreign key.
     */
    activeLeafId: text("active_leaf_id"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("threads_updated_idx").on(t.updatedAt),
    index("threads_project_idx").on(t.projectId),
    index("threads_assistant_idx").on(t.assistantId),
  ],
);

/**
 * Migration 5. A folder for threads. Archived rather than deleted, so the threads
 * filed under it keep a name to fall back to.
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  archivedAt: text("archived_at"),
});

/**
 * Migration 5. A reusable send configuration: the model, the temperature, and the
 * system prompt that goes in front of the conversation.
 *
 * `temperature` is `real` because a provider's temperature is a float (0.2 is a
 * meaningful value), and the default matches what most providers use when the field
 * is omitted.
 */
export const assistants = sqliteTable(
  "assistants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    model: text("model").notNull(),
    systemPrompt: text("system_prompt").notNull().default(""),
    temperature: real("temperature").notNull().default(0.7),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    archivedAt: text("archived_at"),
  },
  (t) => [index("assistants_updated_idx").on(t.updatedAt)],
);

/** Migration 5. A saved prompt. Deleted for real: it is only text, and there is nothing to cascade. */
export const prompts = sqliteTable(
  "prompts",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("prompts_updated_idx").on(t.updatedAt)],
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
    /**
     * Migration 7. The knowledge chunks this answer was grounded on, as a JSON array of
     * `{ chunkId, documentId, documentTitle, ordinal }`. Null means the turn used no
     * knowledge — not "retrieval found nothing", which is also nothing to show.
     */
    citationsJson: text("citations_json"),
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

/**
 * Migration 3. Provider settings as rows rather than columns: the set of things a
 * settings screen owns grows, and a new key must not be a migration.
 *
 * No index beyond the primary key — the only read is `WHERE key IN (...)`, which
 * SQLite answers from the primary key index.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/**
 * Migration 6. A local MCP server: a command, its ordered arguments, and whether it is
 * switched on.
 *
 * `argsJson` and `envJson` are JSON text, because an argument list is an ordered vector
 * and nothing queries into it: the row is read whole, parsed once, and handed to
 * `spawn` with `shell: false`. `envJson` and `enabled` are written by nobody in this
 * phase (see `migrations.ts`): they exist so the next affordance is not a migration.
 */
export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    command: text("command").notNull(),
    argsJson: text("args_json").notNull().default("[]"),
    envJson: text("env_json").notNull().default("{}"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("mcp_servers_created_idx").on(t.createdAt)],
);

/**
 * Migration 6. One row per tool call the user was asked to approve.
 *
 * The status is the whole point: `pending` means nothing has run, and every terminal
 * state is written by the one conditional UPDATE in `repo-mcp.ts`, so a second resolve
 * matches no row instead of running a tool twice.
 */
export const mcpApprovals = sqliteTable(
  "mcp_approvals",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    argsJson: text("args_json").notNull().default("{}"),
    status: text("status", { enum: ["pending", "executed", "denied", "failed"] }).notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    index("mcp_approvals_server_idx").on(t.serverId, t.createdAt),
    index("mcp_approvals_status_idx").on(t.status),
  ],
);

/**
 * Migration 7. One indexed document: the copy main made, and where it came from.
 *
 * `sourcePath` is unique so indexing the same file twice is a refusal rather than a second
 * copy and a second embedding bill. `chunkCount` is written with the chunks, in one
 * transaction, so a list read is one query instead of one per row.
 */
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    sourcePath: text("source_path").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("documents_source_idx").on(t.sourcePath),
    index("documents_created_idx").on(t.createdAt),
  ],
);

/**
 * Migration 7. One chunk of a document, with its vector.
 *
 * The vector is a BLOB of float32s and `dim` is stored beside it rather than derived from
 * the byte length: a truncated or empty blob must not read as a legal vector, and a query
 * embedded by a different model is refused by dimension rather than compared as noise.
 */
export const chunks = sqliteTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    embedding: blob("embedding", { mode: "buffer" }).notNull(),
    dim: integer("dim").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    uniqueIndex("chunks_document_ordinal_idx").on(t.documentId, t.ordinal),
    index("chunks_dim_idx").on(t.dim),
  ],
);

/** Migration 7. A named document a thread owns; `currentVersion` names the newest row below. */
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("artifacts_thread_idx").on(t.threadId, t.createdAt)],
);

/**
 * Migration 7. One immutable revision.
 *
 * Nothing updates or deletes a row here. "Edit" is an insert at n+1, which is what makes a
 * version switcher meaningful and what `UNIQUE (artifact_id, version)` protects.
 */
export const artifactVersions = sqliteTable(
  "artifact_versions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [uniqueIndex("artifact_versions_unique_idx").on(t.artifactId, t.version)],
);

export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ContentBlock = typeof contentBlocks.$inferSelect;
export type Generation = typeof generations.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Assistant = typeof assistants.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type McpServerRecord = typeof mcpServers.$inferSelect;
export type McpApprovalRecord = typeof mcpApprovals.$inferSelect;
export type DocumentRecord = typeof documents.$inferSelect;
export type ChunkRecord = typeof chunks.$inferSelect;
export type ArtifactRecord = typeof artifacts.$inferSelect;
export type ArtifactVersionRecord = typeof artifactVersions.$inferSelect;

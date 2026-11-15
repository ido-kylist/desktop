/**
 * The single source of truth for every main <-> renderer channel.
 *
 * Both sides import this file. Nothing else may declare a channel name.
 * Adding a channel is a contract change and requires a protocol version bump.
 *
 * Invariants this file enforces:
 *  - every request and response is parsed with Zod at the boundary
 *  - the renderer never learns a table name, a query, or a credential
 *  - errors are a closed set, so the UI can render every failure honestly
 *  - the channel list is imported from `channels.ts`, which carries no zod, so the
 *    sandboxed preload can validate names without pulling a bundler-invisible dep
 */

import { z } from "zod";
import { CHANNEL_NAMES, type ChannelName } from "./channels";

export * from "./channels";

/* ------------------------------------------------------------------ errors */

export const ErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNKNOWN_CHANNEL",
  "PROTOCOL_MISMATCH",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "BUDGET_EXCEEDED",
  "UPSTREAM_ERROR",
  "UPSTREAM_TRUNCATED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const IpcErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  /** Present for RATE_LIMITED and BUDGET_EXCEEDED so the UI can count down. */
  retryAfterMs: z.number().int().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

/** Every handler returns this shape. There is no throwing across the boundary. */
export const ipcResultSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: IpcErrorSchema }),
  ]);

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

/** D4: a stored file attached to a message. The bytes never travel in this shape. */
export const AttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  kind: z.enum(["image", "document"]),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/* ------------------------------------------------------- D6: the entities */

/**
 * A project is a folder for threads: a name, and an archive date instead of a
 * delete. Archiving hides it from the picker without orphaning the threads that
 * were filed under it — the same trade `threads.archived_at` makes.
 */
export const ProjectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * An assistant is a reusable send configuration: which model, how warm, and the
 * system prompt that goes in front of the conversation.
 *
 * `temperature` is a plain number rather than an integer because that is what the
 * provider takes; 0 and 2 are legal values, so it is not clamped here either.
 */
export const AssistantSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  model: z.string(),
  systemPrompt: z.string(),
  temperature: z.number().min(0).max(2),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export type Assistant = z.infer<typeof AssistantSchema>;

/** A saved prompt. No archive date: deleting one is the user's intent, and it is only text. */
export const PromptSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Prompt = z.infer<typeof PromptSchema>;

/* --------------------------------------------------------------- D7: MCP */

/**
 * Where a server's process is, right now.
 *
 * This is runtime state, deliberately not a database column: it describes the child
 * process the app is holding, and a row that outlived its process would be a lie. On
 * relaunch every server is `stopped`.
 */
export const McpServerStatusSchema = z.enum(["stopped", "starting", "ready", "crashed"]);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

/**
 * One tool a server advertises.
 *
 * `inputSchema` is the server's own JSON Schema, carried through untouched: main does not
 * validate arguments against it, because a schema this app did not write is not something
 * it should claim to enforce. It is `unknown` to the renderer only in the sense that
 * nothing there interprets it either — it is shown, not trusted.
 */
export const McpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type McpTool = z.infer<typeof McpToolSchema>;

/**
 * A configured server plus the state of the process behind it.
 *
 * `toolCount` is what the last `tools/list` returned (zero before one has run), and
 * `lastError` is the last line of a crashed server's stderr — kept because "it crashed"
 * with no reason is a support ticket, not a state a user can act on.
 */
export const McpServerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  status: McpServerStatusSchema,
  toolCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/**
 * An approval's terminal state. `pending` is the only non-terminal one, and an approval
 * that is not pending cannot be resolved again — a second Allow is a CONFLICT, not a
 * second execution.
 */
export const McpApprovalStatusSchema = z.enum(["pending", "executed", "denied", "failed"]);
export type McpApprovalStatus = z.infer<typeof McpApprovalStatusSchema>;

/* -------------------------------------------------- D8: knowledge + artifacts */

/**
 * One indexed document.
 *
 * `sourcePath` is where the file came from, kept so the panel can say *which* of several
 * `notes.md` a row is. It is not a path the renderer may read: the bytes live in a copy
 * under the app's own data directory, and this field is only a label.
 *
 * `chunkCount` is stored, not counted per row on every read. It is written in the same
 * transaction as the chunks, so it cannot drift from them, and a list of a hundred
 * documents does not cost a hundred `COUNT(*)` subqueries.
 */
export const KnowledgeDocumentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  sourcePath: z.string(),
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;

/**
 * A retrieved chunk, as the answer cites it.
 *
 * Deliberately four fields and no text: this list is persisted on the assistant message
 * and replayed on every `chat.thread`, so it is capped at k=5 rows of metadata rather than
 * four kilobytes of document text per turn. The text is read on demand through
 * `kb.readChunk` when a citation is expanded — see `docs/DECISIONS.md`.
 */
export const CitationSchema = z.object({
  chunkId: z.uuid(),
  documentId: z.uuid(),
  documentTitle: z.string(),
  ordinal: z.number().int().nonnegative(),
});
export type Citation = z.infer<typeof CitationSchema>;

/**
 * One search result: a citation plus the text it points at and how close it was.
 *
 * `score` is a cosine in [-1, 1]. It is shown rather than hidden because a preview whose
 * ranking cannot be inspected is a preview nobody can debug.
 */
export const KnowledgeHitSchema = CitationSchema.extend({
  text: z.string(),
  score: z.number().min(-1).max(1),
});
export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>;

/** A chunk by id, for expanding a citation after a relaunch. */
export const KnowledgeChunkSchema = CitationSchema.extend({ text: z.string() });
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

/**
 * A versioned artifact: a named document a thread owns.
 *
 * `currentVersion` is the newest version *number*; the rows themselves are immutable, so
 * "edit" always means "write version n+1". There is no updated-at: the newest version's
 * timestamp is that fact, and a second column could disagree with it.
 */
export const ArtifactSchema = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  title: z.string(),
  currentVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** One immutable revision. `UNIQUE(artifact_id, version)` is the database's promise. */
export const ArtifactVersionSchema = z.object({
  id: z.uuid(),
  artifactId: z.uuid(),
  version: z.number().int().positive(),
  content: z.string(),
  createdAt: z.iso.datetime(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

/* ---------------------------------------------------------------- channels */

type Contract = { request: z.ZodTypeAny; response: z.ZodTypeAny };

export const contracts = {
  "app.info": {
    request: z.object({}),
    response: z.object({
      name: z.string(),
      version: z.string(),
      electron: z.string(),
      chrome: z.string(),
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
      protocolVersion: z.number().int().positive(),
      isPackaged: z.boolean(),
      startedAt: z.iso.datetime(),
    }),
  },
  "app.ping": {
    request: z.object({ nonce: z.string().min(1) }),
    response: z.object({ nonce: z.string(), at: z.iso.datetime(), seq: z.number().int() }),
  },
  "db.health": {
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      schemaVersion: z.number().int().nonnegative(),
      fts5: z.boolean(),
      threads: z.number().int().nonnegative(),
      messages: z.number().int().nonnegative(),
    }),
  },

  /**
   * The key is write-only across this boundary: it goes in, and the only thing
   * that ever comes back is whether one exists and a masked tail (invariant 2).
   */
  "secrets.status": {
    request: z.object({}),
    response: z.object({ hasKey: z.boolean(), masked: z.string().nullable() }),
  },
  "secrets.setKey": {
    request: z.object({ key: z.string().min(1) }),
    response: z.object({ hasKey: z.boolean(), masked: z.string().nullable() }),
  },
  "secrets.clearKey": {
    request: z.object({}),
    response: z.object({ hasKey: z.literal(false) }),
  },

  /**
   * Returns as soon as the turn is persisted; the answer itself arrives on
   * `generation:event`. `threadId: null` starts a new thread, and the response
   * carries the id it was given.
   */
  "chat.send": {
    request: z.object({
      threadId: z.uuid().nullable(),
      text: z.string().min(1),
      /**
       * D6: optional, because an assistant can supply it. When both are absent the
       * turn is refused with BAD_REQUEST rather than sent to a guessed model.
       */
      model: z.string().min(1).optional(),
      /** D6: whose system prompt, model and temperature this turn runs with. */
      assistantId: z.uuid().nullable().optional(),
      /** D6: the project a *new* thread is filed under. Ignored for an existing thread. */
      projectId: z.uuid().nullable().optional(),
      /** D4: ids returned by `attachments.add`, already stored and capped. */
      attachmentIds: z.array(z.uuid()).max(10).optional(),
      /**
       * D8: retrieve from the knowledge base before answering. When false or absent the
       * turn is unchanged, so a thread that never used knowledge is not affected by the
       * setting being on somewhere else.
       */
      useKnowledge: z.boolean().optional(),
      /**
       * D8: narrow retrieval to these documents. Absent means "every indexed document";
       * an empty array is not accepted, because "no documents" is the same thing as
       * `useKnowledge: false` and two spells for one intent is one too many.
       */
      documentIds: z.array(z.uuid()).min(1).max(50).optional(),
    }),
    response: z.object({
      threadId: z.uuid(),
      userMessageId: z.uuid(),
      assistantMessageId: z.uuid(),
      generationId: z.uuid(),
      /**
       * D8: what the turn was grounded on, in marker order. Present only when retrieval
       * ran and found something. It travels with the response so the chips appear on the
       * live turn instead of waiting for a reload of the thread.
       */
      citations: z.array(CitationSchema).optional(),
    }),
  },
  "chat.stop": {
    request: z.object({ generationId: z.uuid() }),
    response: z.object({ stopped: z.boolean() }),
  },

  /**
   * The read side of a conversation: what makes "quit and relaunch restores the
   * thread" (gate G1) possible. One thread, its messages, oldest first.
   *
   * Deliberately the whole thread and nothing else — no pagination, no search, no
   * thread list. Those belong to the sidebar slice, and a narrow contract is the
   * cheapest way to keep this one honest.
   *
   * `generationId` and `errorCode` are carried per message so a restored thread
   * can tell a failed turn from an interrupted one without re-reading a stream.
   */
  "chat.thread": {
    request: z.object({ threadId: z.uuid() }),
    response: z.object({
      thread: z.object({
        id: z.uuid(),
        title: z.string(),
        updatedAt: z.iso.datetime(),
        /** D6: the project this thread is filed under, if any. */
        projectId: z.uuid().nullable(),
        /** D6: the assistant it was last sent with, if any. */
        assistantId: z.uuid().nullable(),
      }),
      messages: z.array(
        z.object({
          id: z.uuid(),
          /** Mirrors the database column exactly; the UI only renders user/assistant. */
          role: z.enum(["user", "assistant", "system", "tool"]),
          text: z.string(),
          createdAt: z.iso.datetime(),
          generationId: z.uuid().nullable(),
          errorCode: ErrorCodeSchema.nullable(),
          /** Tree position (D3). Absent on oldest rows means "root". */
          parentId: z.uuid().nullable().optional(),
          variantOf: z.uuid().nullable().optional(),
          /** Sibling ids that share a parent — the "2 / 3" affordance. */
          variants: z.array(z.uuid()).optional(),
          /** Per-message meters from the generations row, when one exists. */
          usage: z
            .object({
              promptTokens: z.number().int().nonnegative(),
              completionTokens: z.number().int().nonnegative(),
              costMicrocents: z.number().int().nonnegative(),
            })
            .nullable()
            .optional(),
          /** D4: files attached to this message, metadata only. */
          attachments: z.array(AttachmentSchema).optional(),
          /**
           * D8: the chunks this answer was grounded on, in marker order. Absent on a
           * message that used no knowledge — which is different from an empty list that
           * retrieval ran and produced, and the UI renders nothing for both.
           */
          citations: z.array(CitationSchema).optional(),
        }),
      ),
      /** The message whose ancestor path is active; null means "follow the newest leaf". */
      activeLeafId: z.uuid().nullable().optional(),
    }),
  },

  /* ---------------------------------------------------------------- D3 tree */

  "chat.regenerate": {
    request: z.object({ messageId: z.uuid() }),
    response: z.object({
      threadId: z.uuid(),
      userMessageId: z.uuid(),
      assistantMessageId: z.uuid(),
      generationId: z.uuid(),
    }),
  },

  "chat.setActiveVariant": {
    request: z.object({ threadId: z.uuid(), messageId: z.uuid() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /* -------------------------------------------------------------- D2 history */

  "threads.list": {
    request: z.object({
      /** FTS5 match against message text; omitted or empty means "everything". */
      query: z.string().max(500).optional(),
      /** D6: only threads filed under this project; absent means "every project". */
      projectId: z.uuid().optional(),
      limit: z.number().int().min(1).max(200),
      offset: z.number().int().min(0),
      includeArchived: z.boolean(),
    }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          updatedAt: z.iso.datetime(),
          pinned: z.boolean(),
          archivedAt: z.iso.datetime().nullable(),
          messageCount: z.number().int().nonnegative(),
          /** D6: carried per row so the list can say which project a thread is in. */
          projectId: z.uuid().nullable(),
          /** First matching line of text, for the search result row. */
          snippet: z.string().nullable(),
        }),
      ),
      total: z.number().int().nonnegative(),
    }),
  },

  "threads.update": {
    request: z.object({
      threadId: z.uuid(),
      title: z.string().min(1).max(200).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
  },

  "threads.delete": {
    request: z.object({ threadId: z.uuid() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /* --------------------------------------------------- P0 provider settings */

  "settings.get": {
    request: z.object({}),
    response: z.object({
      /** Null means "not configured"; the resolver falls back to env, then mock, then a clear error. */
      baseUrl: z.string().nullable(),
      defaultModel: z.string().nullable(),
      /**
       * D8: the model retrieval embeds with. Never null: the stored value or the default,
       * because a blank embedding model is not a configuration, it is a broken search.
       */
      embeddingModel: z.string(),
      hasKey: z.boolean(),
      /** Last four only. The key itself never appears in any response. */
      masked: z.string().nullable(),
    }),
  },

  "settings.set": {
    request: z.object({
      baseUrl: z.string().max(500).nullable().optional(),
      defaultModel: z.string().max(200).nullable().optional(),
      /** Cleared (null) falls back to the default; the response reports the effective one. */
      embeddingModel: z.string().max(200).nullable().optional(),
    }),
    response: z.object({
      baseUrl: z.string().nullable(),
      defaultModel: z.string().nullable(),
      embeddingModel: z.string(),
      hasKey: z.boolean(),
      masked: z.string().nullable(),
    }),
  },

  "models.list": {
    request: z.object({}),
    response: z.object({
      models: z.array(z.object({ id: z.string(), ownedBy: z.string().nullable() })),
      /** Where the list came from, so the UI can say so instead of implying authority. */
      source: z.enum(["remote", "fallback", "mock"]),
      /** Populated when the remote call failed and a fallback was used. */
      message: z.string().nullable(),
    }),
  },

  /* ----------------------------------------------------- D4 attachments */

  "attachments.add": {
    request: z.object({
      /** Absolute paths, as dropped or picked. Main owns the file system; the renderer never does. */
      paths: z.array(z.string().min(1)).min(1).max(10),
    }),
    response: z.object({ attachments: z.array(AttachmentSchema) }),
  },

  "attachments.preview": {
    request: z.object({ id: z.uuid() }),
    response: z.object({
      /** A data URL for small images only; null means "no inline preview available". */
      dataUrl: z.string().nullable(),
      mime: z.string(),
    }),
  },

  /* ---------------------------------------------------- D5 native shell */

  "native.showLauncher": {
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
  },

  /* ------------------------------------------------- D6 projects (threads) */

  /**
   * The sidebar's project list. Archived projects are not listed: archiving one is
   * how a user puts it away, and there is no restore affordance to put it back with.
   *
   * `threadCount` is counted in SQL over live threads, because a project with a
   * count of zero and a project whose count was never read look identical to a user
   * and are different facts to a test.
   */
  "projects.list": {
    request: z.object({}),
    response: z.object({
      items: z.array(ProjectSchema.extend({ threadCount: z.number().int().nonnegative() })),
      total: z.number().int().nonnegative(),
    }),
  },

  "projects.create": {
    request: z.object({ name: z.string().trim().min(1).max(120) }),
    response: ProjectSchema,
  },

  /** Rename, archive, or both. Absent fields are left alone; archived:false restores. */
  "projects.update": {
    request: z.object({
      projectId: z.uuid(),
      name: z.string().trim().min(1).max(120).optional(),
      archived: z.boolean().optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
  },

  /* ------------------------------------------------------ D6 assistants */

  "assistants.list": {
    request: z.object({ includeArchived: z.boolean() }),
    response: z.object({
      items: z.array(AssistantSchema),
      total: z.number().int().nonnegative(),
    }),
  },

  "assistants.create": {
    request: z.object({
      name: z.string().trim().min(1).max(80),
      model: z.string().trim().min(1).max(200),
      systemPrompt: z.string().max(20_000),
      temperature: z.number().min(0).max(2),
    }),
    response: AssistantSchema,
  },

  /** The whole editable row: a partial patch, so a rename does not resend the prompt. */
  "assistants.update": {
    request: z.object({
      assistantId: z.uuid(),
      name: z.string().trim().min(1).max(80).optional(),
      model: z.string().trim().min(1).max(200).optional(),
      systemPrompt: z.string().max(20_000).optional(),
      temperature: z.number().min(0).max(2).optional(),
      archived: z.boolean().optional(),
    }),
    response: AssistantSchema,
  },

  /** Archiving, not removal: threads keep pointing at the assistant they were sent with. */
  "assistants.delete": {
    request: z.object({ assistantId: z.uuid() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /* --------------------------------------------------------- D6 prompts */

  /**
   * The library, and its search. `query` is matched over title and body **in SQL**,
   * so the renderer never receives a list it then filters — a large library would
   * cross the boundary whole and the count would be a lie.
   */
  "prompts.list": {
    request: z.object({
      query: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(200),
      offset: z.number().int().min(0),
    }),
    response: z.object({
      items: z.array(PromptSchema),
      total: z.number().int().nonnegative(),
    }),
  },

  "prompts.create": {
    request: z.object({
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(20_000),
    }),
    response: PromptSchema,
  },

  "prompts.update": {
    request: z.object({
      promptId: z.uuid(),
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().trim().min(1).max(20_000).optional(),
    }),
    response: PromptSchema,
  },

  "prompts.delete": {
    request: z.object({ promptId: z.uuid() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /* ------------------------------------------------------------ D7: MCP */

  /**
   * Every configured server, with the live state of its process.
   *
   * A read: it never spawns anything. A server with no process is `stopped`, and it stays
   * that way until something asks for its tools or for one of its tools to run.
   */
  "mcp.listServers": {
    request: z.object({}),
    response: z.object({
      items: z.array(McpServerSchema),
      total: z.number().int().nonnegative(),
    }),
  },

  /**
   * Persist a server. No process is started here: adding a command to a list is not the
   * same act as running it, and a user who adds one and leaves is not owed a process.
   *
   * `args` is an array, not a shell string — `spawn` is called with `shell: false`, so
   * nothing in a server's arguments is ever interpreted by a shell.
   */
  "mcp.addServer": {
    request: z.object({
      name: z.string().trim().min(1).max(80),
      command: z.string().trim().min(1).max(500),
      args: z.array(z.string().max(500)).max(32),
    }),
    response: McpServerSchema,
  },

  /** Removes the row and its approvals, and stops the process first if one is running. */
  "mcp.removeServer": {
    request: z.object({ serverId: z.uuid() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Stops the process and leaves the row. A crashed server is killed and its tools listed
   * again; a mistake in the command is removed rather than killed.
   */
  "mcp.killServer": {
    request: z.object({ serverId: z.uuid() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Starts the server if it is not running, initialises, and asks for `tools/list`. A
   * server that cannot be started or does not answer within the timeout is an error with
   * a code, never a hang.
   */
  "mcp.listTools": {
    request: z.object({ serverId: z.uuid() }),
    response: z.object({ tools: z.array(McpToolSchema) }),
  },

  /**
   * Asks to run one tool. **Nothing runs.** The request is recorded as a pending approval
   * and the id comes back; the tool runs only when `mcp.resolveApproval` is told to allow
   * it, and every call needs its own approval — there is no "remember this".
   *
   * `args` is the tool's own argument object, passed through unchanged. It is the one part
   * of this contract that can carry a secret, which is why nothing logs it.
   */
  "mcp.requestToolCall": {
    request: z.object({
      serverId: z.uuid(),
      tool: z.string().min(1).max(200),
      args: z.record(z.string(), z.unknown()),
    }),
    response: z.object({ approvalId: z.uuid() }),
  },

  /**
   * The only path from an approval to an executed tool.
   *
   * `denied` is a result, not an error: the user refusing is a decision that was carried
   * out, and it is recorded. `failed` means the call was allowed and did not complete —
   * a timeout, a crash, or a JSON-RPC error — and carries the reason in `error`.
   */
  "mcp.resolveApproval": {
    request: z.object({ approvalId: z.uuid(), allow: z.boolean() }),
    response: z.object({
      status: z.enum(["executed", "denied", "failed"]),
      /** The server's own `tools/call` result, verbatim. Present only when executed. */
      result: z.unknown().optional(),
      /** Why a `failed` call failed. Present only when failed. */
      error: z.string().optional(),
    }),
  },

  /* ------------------------------------------------------------- D8: knowledge */

  /**
   * Indexes files: copy, chunk, embed, and record — in that order, and only the last step
   * is transactional.
   *
   * The caps and the extension table are the attachment module's, not a second copy of
   * them: a file this app will not attach is a file it will not index, and two lists that
   * disagree about `.md` would be a defect with no author.
   */
  "kb.addDocument": {
    request: z.object({
      /** Absolute paths, as picked. Main owns the file system; the renderer never does. */
      paths: z.array(z.string().min(1)).min(1).max(10),
    }),
    response: z.object({ documents: z.array(KnowledgeDocumentSchema) }),
  },

  "kb.listDocuments": {
    request: z.object({}),
    response: z.object({
      items: z.array(KnowledgeDocumentSchema),
      total: z.number().int().nonnegative(),
    }),
  },

  /** Removes the row, its chunks (by cascade) and the stored copy. */
  "kb.deleteDocument": {
    request: z.object({ documentId: z.uuid() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Retrieval on its own, for the panel's preview. The answer path does not go through
   * this channel: `chat.send` retrieves inside main, because the citation list has to be
   * persisted with the message and a round trip through the renderer would let the two
   * disagree about what the answer was given.
   */
  "kb.search": {
    request: z.object({
      query: z.string().trim().min(1).max(2000),
      limit: z.number().int().min(1).max(50),
    }),
    response: z.object({ chunks: z.array(KnowledgeHitSchema) }),
  },

  /**
   * One chunk's text, for expanding a citation. Separate from `kb.search` because a
   * citation is a pointer: it is stored on the message, replayed on relaunch, and expanded
   * by the user later, when re-running the query would be a different query.
   */
  "kb.readChunk": {
    request: z.object({ chunkId: z.uuid() }),
    response: z.object({ chunk: KnowledgeChunkSchema }),
  },

  /* ------------------------------------------------------------- D8: artifacts */

  /** A thread's artifacts, newest first. No versions: the row says which one is current. */
  "artifacts.list": {
    request: z.object({ threadId: z.uuid() }),
    response: z.object({
      items: z.array(ArtifactSchema),
      total: z.number().int().nonnegative(),
    }),
  },

  /**
   * One artifact and every version it has ever had, oldest first.
   *
   * `latest` is the version `artifact.currentVersion` names, repeated rather than left for
   * the caller to pick out of the list: every screen that opens this read wants that one,
   * and a client that had to search for it could disagree with the row about which is newest.
   */
  "artifacts.get": {
    request: z.object({ artifactId: z.uuid() }),
    response: z.object({
      artifact: ArtifactSchema,
      versions: z.array(ArtifactVersionSchema),
      latest: ArtifactVersionSchema,
    }),
  },

  /**
   * Writes a version. `artifactId: null` creates the artifact at version 1; an id writes
   * version n+1 and returns it. An edit is never a mutation of an old row — that is what
   * makes "go back to v2" possible and what the `UNIQUE(artifact_id, version)` enforces.
   *
   * `threadId` is required either way: an artifact belongs to a conversation, and creating
   * one with no thread to show it in would be a row nobody can reach.
   */
  "artifacts.save": {
    request: z.object({
      artifactId: z.uuid().nullable(),
      threadId: z.uuid(),
      title: z.string().trim().min(1).max(200),
      content: z.string().max(200_000),
    }),
    response: z.object({ artifact: ArtifactSchema, version: ArtifactVersionSchema }),
  },
} as const satisfies Record<ChannelName, Contract>;

export type Contracts = typeof contracts;
export type RequestOf<C extends ChannelName> = z.infer<Contracts[C]["request"]>;
export type ResponseOf<C extends ChannelName> = z.infer<Contracts[C]["response"]>;

/** Every channel, as a value — derived from the same tuple the preload uses. */
export const CHANNELS = CHANNEL_NAMES;

/* ------------------------------------------------------- generation stream */

/**
 * The typed event stream (plan invariant 5). Monotonic `seq` per generation,
 * stable `generationId` across a retry, applied idempotently by the renderer.
 */
const seq = z.number().int().nonnegative();

export const GenerationEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    generationId: z.uuid(),
    threadId: z.uuid(),
    messageId: z.uuid(),
    seq,
    at: z.iso.datetime(),
  }),
  z.object({ type: z.literal("delta"), generationId: z.uuid(), seq, text: z.string() }),
  z.object({ type: z.literal("reasoning"), generationId: z.uuid(), seq, text: z.string() }),
  z.object({
    type: z.literal("toolCall"),
    generationId: z.uuid(),
    seq,
    callId: z.string(),
    name: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("toolResult"),
    generationId: z.uuid(),
    seq,
    callId: z.string(),
    ok: z.boolean(),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("usage"),
    generationId: z.uuid(),
    seq,
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    costMicrocents: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("done"),
    generationId: z.uuid(),
    seq,
    finishReason: z.enum(["stop", "length", "tool_calls", "content_filter", "error"]),
  }),
  z.object({ type: z.literal("error"), generationId: z.uuid(), seq, error: IpcErrorSchema }),
]);
export type GenerationEvent = z.infer<typeof GenerationEventSchema>;

/* ------------------------------------------------------------- renderer API */

/** The shape `contextBridge` exposes as `window.cleon`. Nothing else is exposed. */
export interface CleonApi {
  readonly protocolVersion: number;
  invoke<C extends ChannelName>(
    channel: C,
    payload: RequestOf<C>,
  ): Promise<IpcResult<ResponseOf<C>>>;
  /**
   * Subscribes to the generation stream (invariant 5). Returns an unsubscribe
   * function. Events for every generation share this channel; filter on
   * `generationId`, and apply them idempotently by `seq`.
   */
  onGenerationEvent(listener: (event: GenerationEvent) => void): () => void;
}

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
    }),
    response: z.object({
      threadId: z.uuid(),
      userMessageId: z.uuid(),
      assistantMessageId: z.uuid(),
      generationId: z.uuid(),
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
      hasKey: z.boolean(),
      /** Last four only. The key itself never appears in any response. */
      masked: z.string().nullable(),
    }),
  },

  "settings.set": {
    request: z.object({
      baseUrl: z.string().max(500).nullable().optional(),
      defaultModel: z.string().max(200).nullable().optional(),
    }),
    response: z.object({
      baseUrl: z.string().nullable(),
      defaultModel: z.string().nullable(),
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

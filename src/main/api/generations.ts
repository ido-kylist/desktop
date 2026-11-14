import { randomUUID } from "node:crypto";
import type { GenerationEvent, IpcError, RequestOf, ResponseOf } from "@shared/ipc-contract";
import type { DrizzleDb } from "../db/client.js";
import {
  createThread,
  finishGeneration,
  getThreadWithMessages,
  insertGeneration,
  insertMessage,
  touchThread,
  updateMessageText,
} from "../db/repo.js";
import type { Message } from "../db/schema.js";
import { AppError, toIpcError } from "../errors.js";
import type { GenerationBus } from "./bus.js";
import {
  type ChatDelta,
  type ChatMessage,
  type InferenceConfig,
  streamChatCompletion,
} from "./client.js";

/**
 * One turn of a conversation, end to end.
 *
 * The order is the invariant: thread, user message, empty assistant message,
 * generation row — all durable — and only then the network call. `chat.send`
 * returns those ids immediately; the answer arrives as events on the bus, which
 * the main process forwards to the window that asked. Nothing here imports
 * Electron, which is what lets the whole flow run against the real mock server in
 * a test with nothing but a temp database.
 */

export type ChatSendRequest = RequestOf<"chat.send">;
export type ChatSendResponse = ResponseOf<"chat.send">;
export type ChatStopResponse = ResponseOf<"chat.stop">;

/** Where this turn's events go. The main process points it at one webContents. */
export type GenerationSink = (event: GenerationEvent) => void;

export interface GenerationDeps {
  db: DrizzleDb;
  bus: GenerationBus;
  /**
   * Read per turn, not cached: the key lives in secure storage and can change
   * between turns. Also where an unconfigured base URL surfaces, as `INTERNAL`.
   */
  resolveConfig: () => Promise<InferenceConfig>;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
  /** Milliseconds clock for checkpoint pacing. Injected so tests need no sleeps. */
  clock?: () => number;
  checkpointIntervalMs?: number;
}

/** Decision 9: a checkpoint at most this often, plus one at the end. */
const DEFAULT_CHECKPOINT_MS = 250;

interface Usage {
  promptTokens: number;
  completionTokens: number;
  costMicrocents: number;
}

interface ToolCall {
  index: number;
  callId: string;
  name: string;
  arguments: string;
}

interface ActiveGeneration {
  controller: AbortController;
  unsubscribe: () => void;
}

interface RunContext {
  generationId: string;
  threadId: string;
  assistantMessageId: string;
  model: string;
  history: ChatMessage[];
  signal: AbortSignal;
  release: () => void;
}

/**
 * The conversation so far, as the model needs to see it.
 *
 * Empty assistant rows are skipped rather than sent: they are the placeholder for
 * a turn that never produced text (an interrupted or failed generation), and an
 * empty assistant message in the prompt is noise the model may imitate.
 */
function toChatMessages(history: readonly Message[], userText: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const message of history) {
    if (message.text === "") continue;
    if (message.role === "tool") continue;
    messages.push({ role: message.role, content: message.text });
  }
  messages.push({ role: "user", content: userText });
  return messages;
}

function accumulateToolCall(
  calls: Map<number, ToolCall>,
  delta: Extract<ChatDelta, { type: "toolCallDelta" }>,
): void {
  const existing = calls.get(delta.index) ?? {
    index: delta.index,
    callId: "",
    name: "",
    arguments: "",
  };
  calls.set(delta.index, {
    index: delta.index,
    // The id and the name arrive once, the arguments in fragments; later
    // fragments leave the earlier fields alone.
    callId: delta.callId ?? existing.callId,
    name: delta.name ?? existing.name,
    arguments: existing.arguments + (delta.args ?? ""),
  });
}

/**
 * A tool call is only meaningful once its argument fragments have been joined,
 * which is why nothing is emitted while the arguments are still arriving.
 * Fragments that never become JSON are kept verbatim: they are still what the
 * model produced, and dropping them would hide the evidence of a bad generation.
 */
function parseToolArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class GenerationService {
  private readonly db: DrizzleDb;
  private readonly bus: GenerationBus;
  private readonly clock: () => number;
  private readonly checkpointIntervalMs: number;
  private readonly active = new Map<string, ActiveGeneration>();

  constructor(private readonly deps: GenerationDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.clock = deps.clock ?? Date.now;
    this.checkpointIntervalMs = deps.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_MS;
  }

  /**
   * Persists the turn and starts it. Returns as soon as the rows exist.
   *
   * Every failure before the network call (an unknown thread) rejects, because
   * nothing has been written and the renderer deserves a normal IPC error. Every
   * failure after it is an event, because by then the turn is durable.
   */
  async send(request: ChatSendRequest, sink: GenerationSink): Promise<ChatSendResponse> {
    const existing =
      request.threadId === null ? null : getThreadWithMessages(this.db, request.threadId);

    if (request.threadId !== null && existing === null) {
      throw new AppError("NOT_FOUND", "thread not found", {
        details: { threadId: request.threadId },
      });
    }

    const threadId = request.threadId ?? randomUUID();
    const parentId = existing?.messages.at(-1)?.id ?? null;
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const generationId = randomUUID();
    const history = toChatMessages(existing?.messages ?? [], request.text);

    // One transaction, because a half-written turn is worse than no turn: a
    // thread with a user message and no generation row would look like a turn
    // that finished instantly. Drizzle on better-sqlite3 is synchronous, so the
    // whole block commits before the first byte goes over the network.
    this.db.transaction((tx) => {
      if (existing === null) createThread(tx, { id: threadId });

      insertMessage(tx, {
        id: userMessageId,
        threadId,
        parentId,
        role: "user",
        text: request.text,
        model: request.model,
      });

      // The assistant row exists before the answer does: a crash mid-stream leaves
      // a resumable turn with a message to attach the checkpoints to.
      insertMessage(tx, {
        id: assistantMessageId,
        threadId,
        parentId: userMessageId,
        role: "assistant",
        text: "",
        model: request.model,
      });
      insertGeneration(tx, {
        id: generationId,
        threadId,
        messageId: assistantMessageId,
        model: request.model,
      });
      touchThread(tx, threadId);
    });

    const controller = new AbortController();
    const unsubscribe = this.bus.subscribe(generationId, sink);
    this.active.set(generationId, { controller, unsubscribe });

    /**
     * Drops the live entry and the bus subscription. Called from the terminal
     * path inside `run` and again from the promise's `finally`: the first makes
     * "is this generation still running" honest the instant the terminal event
     * lands, and the second covers `run` failing before it could terminate.
     * Both operations are idempotent.
     */
    const release = (): void => {
      this.active.delete(generationId);
      unsubscribe();
    };

    const context: RunContext = {
      generationId,
      threadId,
      assistantMessageId,
      model: request.model,
      history,
      signal: controller.signal,
      release,
    };

    // Detached on purpose: the ids are the response, the answer is the stream.
    void this.run(context)
      .catch((error: unknown) => {
        // `run` terminates every turn it can. Reaching this means the terminal
        // write itself failed, which cannot be repaired by emitting an event —
        // so it goes to the process log rather than into an unhandled rejection.
        console.error(
          "[generations] could not record the end of a generation",
          generationId,
          error,
        );
      })
      .finally(release);

    return { threadId, userMessageId, assistantMessageId, generationId };
  }

  /**
   * Aborts the request. The turn still terminates normally — the abort surfaces
   * inside `run` and is recorded as a stop, which is not an error (decision 10).
   * Unknown or already-finished generations are a no-op, so a double tap is safe.
   */
  stop(generationId: string): ChatStopResponse {
    const active = this.active.get(generationId);
    if (active === undefined) return { stopped: false };
    if (active.controller.signal.aborted) return { stopped: false };
    active.controller.abort();
    return { stopped: true };
  }

  private async run(context: RunContext): Promise<void> {
    let seq = 0;
    let text = "";
    let persistedLength = 0;
    let lastCheckpointAt = this.clock();
    let persisted = false;
    const usage: Usage = { promptTokens: 0, completionTokens: 0, costMicrocents: 0 };
    const toolCalls = new Map<number, ToolCall>();

    /**
     * Decision 9: append to memory, write at most every interval. The length
     * comparison also makes the final flush free when nothing new arrived.
     */
    const checkpoint = (force: boolean): void => {
      if (text.length === persistedLength) return;
      if (!force && this.clock() - lastCheckpointAt < this.checkpointIntervalMs) return;
      updateMessageText(this.db, context.assistantMessageId, text);
      persistedLength = text.length;
      lastCheckpointAt = this.clock();
    };

    try {
      this.bus.emit({
        type: "started",
        generationId: context.generationId,
        threadId: context.threadId,
        messageId: context.assistantMessageId,
        seq: seq++,
        at: new Date().toISOString(),
      });

      const config = await this.deps.resolveConfig();

      const outcome = await streamChatCompletion({
        config,
        model: context.model,
        messages: context.history,
        signal: context.signal,
        ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
        onDelta: (delta) => {
          switch (delta.type) {
            case "content": {
              text += delta.text;
              this.bus.emit({
                type: "delta",
                generationId: context.generationId,
                seq: seq++,
                text: delta.text,
              });
              checkpoint(false);
              break;
            }
            case "reasoning": {
              this.bus.emit({
                type: "reasoning",
                generationId: context.generationId,
                seq: seq++,
                text: delta.text,
              });
              break;
            }
            case "toolCallDelta": {
              accumulateToolCall(toolCalls, delta);
              break;
            }
            case "usage": {
              usage.promptTokens = delta.promptTokens;
              usage.completionTokens = delta.completionTokens;
              usage.costMicrocents = delta.costMicrocents;
              this.bus.emit({
                type: "usage",
                generationId: context.generationId,
                seq: seq++,
                promptTokens: delta.promptTokens,
                completionTokens: delta.completionTokens,
                costMicrocents: delta.costMicrocents,
              });
              break;
            }
            case "finish": {
              // The finish reason is taken from `outcome`, which is only known once
              // the body ends: a finish chunk followed by no `[DONE]` is still a
              // truncated stream, so acting on it here would report a lie.
              break;
            }
          }
        },
      });

      // Decision 7: truncation is semantic. A well-framed body that stopped without
      // `[DONE]` or without a finish reason never finished the answer.
      if (!outcome.sawDone || outcome.finishReason === null) {
        throw new AppError("UPSTREAM_TRUNCATED", "stream ended before the model finished", {
          details: { sawDone: outcome.sawDone, finishReason: outcome.finishReason },
        });
      }

      for (const call of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
        this.bus.emit({
          type: "toolCall",
          generationId: context.generationId,
          seq: seq++,
          callId: call.callId,
          name: call.name,
          args: parseToolArguments(call.arguments),
        });
      }

      checkpoint(true);
      finishGeneration(this.db, context.generationId, {
        finishReason: outcome.finishReason,
        errorCode: null,
        ...usage,
      });
      persisted = true;

      this.bus.emit({
        type: "done",
        generationId: context.generationId,
        seq: seq++,
        finishReason: outcome.finishReason,
      });
      context.release();
    } catch (error) {
      const stopped = context.signal.aborted;

      if (persisted) {
        // The turn is already durable and correctly recorded; a listener throwing
        // while receiving the terminal event must not rewrite it.
        console.error("[generations] terminal event delivery failed", context.generationId, error);
        return;
      }

      // Whatever streamed before the failure is still what the user saw.
      checkpoint(true);

      if (stopped) {
        /* Decision 10: a user stop is not an error. The row records no finish reason
         * — the model did not finish this answer — while the event reports `stop`,
         * because the contract's `done` has no "stopped" member and the renderer's
         * only question at that point is whether the stream is over. */
        finishGeneration(this.db, context.generationId, {
          finishReason: null,
          errorCode: null,
          ...usage,
        });
        this.bus.emit({
          type: "done",
          generationId: context.generationId,
          seq: seq++,
          finishReason: "stop",
        });
        context.release();
        return;
      }

      // Decision 8: the failure is an event *and* a column. Both, or the renderer
      // and the database would disagree about how the turn ended.
      const ipcError: IpcError = toIpcError(error);
      finishGeneration(this.db, context.generationId, {
        finishReason: null,
        errorCode: ipcError.code,
        ...usage,
      });
      persisted = true;

      this.bus.emit({
        type: "error",
        generationId: context.generationId,
        seq: seq++,
        error: ipcError,
      });
      context.release();
    }
  }
}

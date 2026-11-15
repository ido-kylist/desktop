import { randomUUID } from "node:crypto";
import type { GenerationEvent, IpcError, RequestOf, ResponseOf } from "@shared/ipc-contract";
import type { DrizzleDb } from "../db/client.js";
import {
  assignThread,
  createThread,
  finishGeneration,
  getMessage,
  getThread,
  getThreadWithMessages,
  insertGeneration,
  insertMessage,
  regenerate as regenerateTurn,
  resolveActivePath,
  resolveAncestorPath,
  touchThread,
  updateMessageText,
} from "../db/repo.js";
import { type AssistantRow, getAssistant } from "../db/repo-assistants.js";
import { assertProjectExists, getProject } from "../db/repo-projects.js";
import type { Message, Thread } from "../db/schema.js";
import { AppError, toIpcError } from "../errors.js";
import { expandPromptVariables, promptClock } from "../prompt-variables.js";
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
  /** D6: from the assistant, when one applied. Undefined means "provider default". */
  temperature: number | undefined;
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
function toPrompt(history: readonly Message[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const message of history) {
    if (message.text === "") continue;
    if (message.role === "tool") continue;
    messages.push({ role: message.role, content: message.text });
  }
  return messages;
}

/** A new turn's prompt: the active path so far, then the message being sent. */
function toChatMessages(history: readonly Message[], userText: string): ChatMessage[] {
  return [...toPrompt(history), { role: "user", content: userText }];
}

/**
 * Which model the turn is addressed to.
 *
 * The request wins, then the assistant, then nothing — and nothing is a refusal rather
 * than a default, because a turn sent to a guessed model is a turn the user did not ask
 * for. A blank string is treated as absent: it is what a cleared input looks like, and
 * `model: ""` would reach the provider as a malformed request.
 */
function resolveModel(
  requested: string | null | undefined,
  assistant: AssistantRow | null,
): string | null {
  const candidate = requested ?? assistant?.model ?? "";
  return candidate.trim() === "" ? null : candidate;
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
   * Every failure before the network call (an unknown thread, an unknown assistant, no
   * model at all) rejects, because nothing has been written and the renderer deserves a
   * normal IPC error. Every failure after it is an event, because by then the turn is
   * durable.
   *
   * D6: an assistant supplies three things — the system prompt that goes in front of the
   * conversation, the model when the request does not name one, and the temperature.
   * Both are resolved *before* the transaction so a bad assistant id cannot leave a
   * half-written turn behind.
   */
  async send(request: ChatSendRequest, sink: GenerationSink): Promise<ChatSendResponse> {
    const existing =
      request.threadId === null ? null : getThreadWithMessages(this.db, request.threadId);

    if (request.threadId !== null && existing === null) {
      throw new AppError("NOT_FOUND", "thread not found", {
        details: { threadId: request.threadId },
      });
    }

    /**
     * A new turn hangs under the leaf the user is looking at, and its prompt is that
     * leaf's ancestor path — not every message in the thread. In an unbranched thread
     * the two are the same list, so nothing changes; once an answer has been
     * regenerated they are not, and continuing from a variant the user rejected
     * would be wrong.
     */
    const path = existing === null ? [] : resolveActivePath(existing);

    /**
     * Which assistant this turn runs with. A missing field keeps whatever the thread
     * already had (a resumed conversation belongs to the assistant it was started
     * with); an explicit null is the user taking the assistant away.
     */
    const assistantId =
      request.assistantId === undefined
        ? (existing?.thread.assistantId ?? null)
        : request.assistantId;
    const assistant = this.loadAssistant(assistantId, "require");

    const model = resolveModel(request.model, assistant);
    if (model === null) {
      throw new AppError("BAD_REQUEST", "no model: pass one, or pick an assistant that has one", {
        details: { assistantId },
      });
    }

    const threadId = request.threadId ?? randomUUID();
    const parentId = path.at(-1)?.id ?? null;
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const generationId = randomUUID();

    /**
     * A project only applies to a thread that does not exist yet: filing an existing
     * conversation under a project on every send would let the sidebar's filter move
     * threads the user never touched.
     */
    const projectId = existing === null ? (request.projectId ?? null) : existing.thread.projectId;
    if (existing === null && projectId !== null) assertProjectExists(this.db, projectId);

    // One transaction, because a half-written turn is worse than no turn: a
    // thread with a user message and no generation row would look like a turn
    // that finished instantly. Drizzle on better-sqlite3 is synchronous, so the
    // whole block commits before the first byte goes over the network.
    this.db.transaction((tx) => {
      if (existing === null) {
        createThread(tx, { id: threadId, projectId, assistantId: assistant?.id ?? null });
      } else if (assistantId !== existing.thread.assistantId) {
        // The picker can change the assistant mid-conversation; the column follows it
        // so a relaunch, a regenerate or the next turn re-applies the same one.
        assignThread(tx, threadId, { assistantId });
      }

      insertMessage(tx, {
        id: userMessageId,
        threadId,
        parentId,
        role: "user",
        text: request.text,
        model,
      });

      // The assistant row exists before the answer does: a crash mid-stream leaves
      // a resumable turn with a message to attach the checkpoints to.
      insertMessage(tx, {
        id: assistantMessageId,
        threadId,
        parentId: userMessageId,
        role: "assistant",
        text: "",
        model,
      });
      insertGeneration(tx, {
        id: generationId,
        threadId,
        messageId: assistantMessageId,
        model,
      });
      touchThread(tx, threadId);
    });

    /**
     * The prompt is built after the transaction, from the thread as it now exists:
     * a new thread's title is the database's default, and `{{thread_title}}` has to
     * expand to the row the user is actually in rather than to a guess made before it
     * was written.
     */
    const stored = getThread(this.db, threadId);
    const history = this.withAssistantPrompt(assistant, stored, toChatMessages(path, request.text));

    this.startTurn(
      {
        generationId,
        threadId,
        assistantMessageId,
        model,
        temperature: assistant?.temperature,
        history,
      },
      sink,
    );

    return { threadId, userMessageId, assistantMessageId, generationId };
  }

  /**
   * Regenerates an assistant message: a sibling under the same parent, streamed by
   * the same orchestrator `chat.send` uses.
   *
   * The rows are written before the network call, exactly as a new turn's are, and
   * the prompt is the ancestor path up to the message being answered — so the second
   * answer is given the same question the first one got, with no trace of the answer
   * it is replacing.
   *
   * D6: the thread's assistant still applies. A second answer written under a different
   * system prompt than the first is not a variant of it, it is a different conversation
   * wearing the same history.
   */
  regenerate(messageId: string, sink: GenerationSink): ResponseOf<"chat.regenerate"> {
    const result = regenerateTurn(this.db, messageId);

    const loaded = getThreadWithMessages(this.db, result.threadId);
    const path = loaded === null ? [] : resolveAncestorPath(loaded, result.userMessageId);
    const thread = getThread(this.db, result.threadId);
    /**
     * Tolerated rather than required: an assistant archived (or lost) between two turns
     * must not turn "regenerate this answer" into an error about a menu entry. The turn
     * falls back to the model the answer being replaced was produced with.
     */
    const assistant = this.loadAssistant(thread?.assistantId ?? null, "tolerate");
    /**
     * The assistant's model wins over the one the replaced answer ran on: re-answering
     * with the model the assistant names is the point of having picked it. A model-less
     * row still regenerates with the stored value, empty string included, exactly as it
     * did before D6.
     */
    const model = assistant?.model ?? getMessage(this.db, result.assistantMessageId)?.model ?? "";

    this.startTurn(
      {
        generationId: result.generationId,
        threadId: result.threadId,
        assistantMessageId: result.assistantMessageId,
        model,
        temperature: assistant?.temperature,
        history: this.withAssistantPrompt(assistant, thread, toPrompt(path)),
      },
      sink,
    );

    return result;
  }

  /**
   * One assistant by id, or the failure the caller asked for.
   *
   * `require` is `chat.send` naming an id: a NOT_FOUND before anything is written is a
   * refusal the user can act on. `tolerate` is a turn resuming whatever the thread
   * already carried, where a missing row must degrade to "no assistant" instead of
   * failing an operation that has nothing to do with the announcement of it.
   */
  private loadAssistant(
    assistantId: string | null,
    mode: "require" | "tolerate",
  ): AssistantRow | null {
    if (assistantId === null) return null;
    const assistant = getAssistant(this.db, assistantId);
    if (assistant === null && mode === "require") {
      throw new AppError("NOT_FOUND", "assistant not found", { details: { assistantId } });
    }
    return assistant;
  }

  /**
   * The system turn an assistant contributes, in front of the conversation.
   *
   * The prompt is expanded here, at send time, and not when the assistant was saved:
   * `{{date}}` has to mean the day the message was sent, and `{{thread_title}}` has to
   * mean the title the thread ended up with. Only the system message is expanded — the
   * user's own text is theirs, and rewriting `{{date}}` inside it would be the app
   * putting words in their mouth.
   */
  private withAssistantPrompt(
    assistant: AssistantRow | null,
    thread: Pick<Thread, "title" | "projectId"> | null,
    history: ChatMessage[],
  ): ChatMessage[] {
    if (assistant === null || assistant.systemPrompt.trim() === "") return history;

    const projectId = thread?.projectId ?? null;
    const projectName = projectId === null ? null : (getProject(this.db, projectId)?.name ?? null);
    const clock = promptClock(new Date(this.clock()));

    return [
      {
        role: "system",
        content: expandPromptVariables(assistant.systemPrompt, {
          date: clock.date,
          time: clock.time,
          threadTitle: thread?.title ?? "",
          projectName,
        }),
      },
      ...history,
    ];
  }

  /**
   * Registers a generation on the bus and runs it detached.
   *
   * Shared by `send` and `regenerate` so there is exactly one place that owns the
   * abort controller, the bus subscription and the release — the ids are the
   * response, the answer is the stream.
   */
  private startTurn(
    input: {
      generationId: string;
      threadId: string;
      assistantMessageId: string;
      model: string;
      temperature: number | undefined;
      history: ChatMessage[];
    },
    sink: GenerationSink,
  ): void {
    const { generationId, threadId, assistantMessageId, model, temperature, history } = input;

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
      model,
      temperature,
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
        ...(context.temperature === undefined ? {} : { temperature: context.temperature }),
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

import type { Attachment, ErrorCode, GenerationEvent, IpcError } from "@shared/ipc-contract";
import { create } from "zustand";
import type { Usage } from "../lib/format";

/**
 * The conversation, as the renderer knows it.
 *
 * One store, four pieces of state: which thread is on screen, its messages, the
 * stream that is currently being applied, and the last transport-level failure.
 * Everything else — the model, the API key, the database — stays in main.
 *
 * Idempotency (plan invariant 5) lives on the message: `lastSeq` is the highest event
 * `seq` applied to that generation, and any event at or below it is dropped. That is
 * why it is per message rather than only on `streaming` — after `done` clears
 * `streaming`, a replayed late event still has to be recognisable as a replay.
 */

export interface ToolCallView {
  callId: string;
  name: string;
  args: unknown;
  /** Null until the matching tool result arrives; nothing marks it as pending. */
  ok: boolean | null;
  result: unknown;
}

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  reasoning: string;
  toolCalls: ToolCallView[];
  createdAt: string | null;
  generationId: string | null;
  errorCode: ErrorCode | null;
  /** Highest event `seq` applied to this message's generation. */
  lastSeq: number;
  /**
   * The meters for this turn. Null means no generation ever reported numbers — it is
   * absence, not zero, and the UI renders nothing rather than inventing `$0.0000`.
   */
  usage?: Usage | null;
  /**
   * D4: files attached to this turn, metadata only. Absent means "none" — the contract
   * makes the field optional on `chat.thread`, and a message written before D4 has no
   * attachments to report.
   */
  attachments?: Attachment[];
}

export interface StreamingState {
  generationId: string;
  seq: number;
}

export interface TurnStart {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  generationId: string;
  text: string;
  createdAt: string;
  /** D4: what was attached to this turn, so its chips appear before a reload would. */
  attachments?: Attachment[];
}

export interface ChatState {
  threadId: string | null;
  messages: ChatMessageView[];
  streaming: StreamingState | null;
  lastError: IpcError | null;

  /**
   * Puts a thread on screen — or, with null, clears the selection for a new chat.
   * The previous transcript is dropped immediately so it cannot be read as belonging
   * to the thread that is about to load.
   */
  selectThread: (threadId: string | null) => void;
  /** Replaces the conversation with what `chat.thread` returned. */
  hydrate: (threadId: string, messages: readonly ChatMessageView[]) => void;
  /** Drops the conversation and its thread id (a thread the database no longer has). */
  forgetThread: () => void;
  /** Adopts the ids `chat.send` returned: the user turn plus the answer placeholder. */
  startTurn: (turn: TurnStart) => void;
  applyEvent: (event: GenerationEvent) => void;
  /** Hides Stop immediately; the terminal event is the authoritative clear. */
  clearStreaming: (generationId?: string) => void;
  setLastError: (error: IpcError | null) => void;
}

export const THREAD_STORAGE_KEY = "cleon.thread";

/**
 * Which thread the renderer was showing, so a relaunch reopens it. Only the id is
 * remembered — the conversation itself is read back from SQLite through `chat.thread`,
 * because the renderer never holds the database as its source of truth.
 *
 * Guarded because this module is imported by the Node unit tests, where there is no
 * DOM and therefore no storage.
 */
function readRememberedThread(): string | null {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(THREAD_STORAGE_KEY);
  return value === null || value === "" ? null : value;
}

function emptyAssistantMessage(
  id: string,
  generationId: string | null,
  createdAt: string | null,
): ChatMessageView {
  return {
    id,
    role: "assistant",
    text: "",
    reasoning: "",
    toolCalls: [],
    createdAt,
    generationId,
    errorCode: null,
    lastSeq: 0,
  };
}

function replaceMessage(
  state: ChatState,
  index: number,
  message: ChatMessageView,
  streaming: StreamingState | null,
): Partial<ChatState> {
  return {
    messages: state.messages.map((existing, i) => (i === index ? message : existing)),
    streaming,
  };
}

function endStreaming(state: ChatState, generationId: string): StreamingState | null {
  return state.streaming?.generationId === generationId ? null : state.streaming;
}

function applyGenerationEvent(state: ChatState, event: GenerationEvent): Partial<ChatState> {
  if (event.type === "started") {
    // Main emits `started` synchronously, before `chat.send` has returned its ids, so
    // this can beat the response to the renderer. Creating the placeholder here keeps
    // the first deltas from being dropped; `startTurn` then adopts it by id.
    if (state.threadId !== null && state.threadId !== event.threadId) return {};

    const existing = state.messages.find((message) => message.id === event.messageId);
    if (existing !== undefined && event.seq <= existing.lastSeq) return {};

    const assistant =
      existing ?? emptyAssistantMessage(event.messageId, event.generationId, event.at);

    return {
      threadId: state.threadId ?? event.threadId,
      messages: existing === undefined ? [...state.messages, assistant] : state.messages,
      streaming: { generationId: event.generationId, seq: event.seq },
    };
  }

  const index = state.messages.findIndex(
    (message) => message.generationId === event.generationId && message.role === "assistant",
  );
  // Not this thread's stream: a generation from another window, or one that started
  // before the last hydrate. Nothing here to update.
  if (index === -1) return {};

  const message = state.messages[index];
  if (message === undefined) return {};
  // The replay guard. A duplicate or out-of-order event must not append its text twice.
  if (event.seq <= message.lastSeq) return {};

  /** The live stream cursor, advanced to this event. */
  const advanced: StreamingState = { generationId: event.generationId, seq: event.seq };

  switch (event.type) {
    case "delta":
      return replaceMessage(
        state,
        index,
        { ...message, text: message.text + event.text, lastSeq: event.seq },
        advanced,
      );

    case "reasoning":
      return replaceMessage(
        state,
        index,
        { ...message, reasoning: message.reasoning + event.text, lastSeq: event.seq },
        advanced,
      );

    case "toolCall":
      return replaceMessage(
        state,
        index,
        {
          ...message,
          lastSeq: event.seq,
          toolCalls: [
            ...message.toolCalls,
            { callId: event.callId, name: event.name, args: event.args, ok: null, result: null },
          ],
        },
        advanced,
      );

    case "toolResult": {
      // Results pair with calls by `callId`. An orphan result carries no name to show;
      // the sequence still advances, so it cannot be replayed into a second row.
      const toolCalls = message.toolCalls.map((call) =>
        call.callId === event.callId ? { ...call, ok: event.ok, result: event.result } : call,
      );
      return replaceMessage(state, index, { ...message, lastSeq: event.seq, toolCalls }, advanced);
    }

    case "usage":
      return replaceMessage(
        state,
        index,
        {
          ...message,
          lastSeq: event.seq,
          usage: {
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            costMicrocents: event.costMicrocents,
          },
        },
        advanced,
      );

    case "done":
      return replaceMessage(
        state,
        index,
        { ...message, lastSeq: event.seq },
        endStreaming(state, event.generationId),
      );

    case "error":
      return {
        ...replaceMessage(
          state,
          index,
          { ...message, lastSeq: event.seq, errorCode: event.error.code },
          endStreaming(state, event.generationId),
        ),
        lastError: event.error,
      };
  }
}

export const useChatStore = create<ChatState>()((set) => ({
  threadId: readRememberedThread(),
  messages: [],
  streaming: null,
  lastError: null,

  selectThread: (threadId) =>
    set((state) => {
      if (state.threadId === threadId) return {};
      return { threadId, messages: [], streaming: null, lastError: null };
    }),

  /**
   * The snapshot wins on structure, the live stream wins on text.
   *
   * A `chat.thread` read can come back while tokens are still arriving (a variant
   * switch, a regenerate refresh), and the snapshot was taken before the newest
   * deltas. Keeping the live text of a message whose `lastSeq` has advanced is what
   * stops a refetch from truncating an answer mid-stream; the snapshot still decides
   * which messages are on the active path.
   */
  hydrate: (threadId, messages) =>
    set((state) => {
      const live = new Map<string, ChatMessageView>();
      if (state.threadId === threadId) {
        for (const message of state.messages) live.set(message.id, message);
      }

      const merged = messages.map((message) => {
        const existing = live.get(message.id);
        if (existing === undefined || existing.lastSeq === 0) return { ...message };
        return {
          ...message,
          text: existing.text,
          reasoning: existing.reasoning,
          toolCalls: existing.toolCalls,
          lastSeq: existing.lastSeq,
          usage: message.usage ?? existing.usage,
        };
      });

      // A stream survives the refresh only if its turn is still on the new path.
      const generations = new Set(
        merged
          .map((message) => message.generationId)
          .filter((generationId): generationId is string => generationId !== null),
      );
      const streaming =
        state.streaming !== null && generations.has(state.streaming.generationId)
          ? state.streaming
          : null;

      return { threadId, messages: merged, streaming, lastError: null };
    }),

  forgetThread: () => set({ threadId: null, messages: [], streaming: null, lastError: null }),

  startTurn: (turn) =>
    set((state) => {
      const assistant =
        state.messages.find((message) => message.id === turn.assistantMessageId) ??
        emptyAssistantMessage(turn.assistantMessageId, turn.generationId, turn.createdAt);

      const userMessage: ChatMessageView = {
        id: turn.userMessageId,
        role: "user",
        text: turn.text,
        reasoning: "",
        toolCalls: [],
        createdAt: turn.createdAt,
        generationId: null,
        errorCode: null,
        lastSeq: 0,
        ...(turn.attachments === undefined || turn.attachments.length === 0
          ? {}
          : { attachments: turn.attachments }),
      };

      const rest = state.messages.filter(
        (message) => message.id !== turn.userMessageId && message.id !== turn.assistantMessageId,
      );

      return {
        threadId: turn.threadId,
        messages: [...rest, userMessage, assistant],
        streaming: { generationId: turn.generationId, seq: assistant.lastSeq },
        lastError: null,
      };
    }),

  applyEvent: (event) => set((state) => applyGenerationEvent(state, event)),

  clearStreaming: (generationId) =>
    set((state) => {
      if (state.streaming === null) return {};
      if (generationId !== undefined && state.streaming.generationId !== generationId) return {};
      return { streaming: null };
    }),

  setLastError: (error) => set({ lastError: error }),
}));

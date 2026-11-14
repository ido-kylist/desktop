import type { ErrorCode, GenerationEvent, IpcError } from "@shared/ipc-contract";
import { create } from "zustand";

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
}

export interface ChatState {
  threadId: string | null;
  messages: ChatMessageView[];
  streaming: StreamingState | null;
  lastError: IpcError | null;

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
      return replaceMessage(state, index, { ...message, lastSeq: event.seq }, advanced);

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

  hydrate: (threadId, messages) =>
    set({
      threadId,
      messages: messages.map((message) => ({ ...message })),
      streaming: null,
      lastError: null,
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

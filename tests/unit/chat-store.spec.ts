import type { GenerationEvent } from "@shared/ipc-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "../../src/renderer/src/store/chat-store.js";

/**
 * The store's contract with the stream. Two properties matter and are asserted
 * separately: the transcript grows exactly once per `seq`, and the failure state is
 * stated with the contract's own error, not a string the UI made up.
 */

const THREAD = "22222222-2222-4222-8222-222222222222";
const USER = "44444444-4444-4444-8444-444444444444";
const ASSISTANT = "33333333-3333-4333-8333-333333333333";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_GENERATION = "55555555-5555-4555-8555-555555555555";
const AT = "2026-01-01T00:00:00.000Z";

function started(seq = 0, generationId = GENERATION): GenerationEvent {
  return { type: "started", generationId, threadId: THREAD, messageId: ASSISTANT, seq, at: AT };
}

function delta(seq: number, text: string, generationId = GENERATION): GenerationEvent {
  return { type: "delta", generationId, seq, text };
}

function beginTurn(): void {
  useChatStore.getState().startTurn({
    threadId: THREAD,
    userMessageId: USER,
    assistantMessageId: ASSISTANT,
    generationId: GENERATION,
    text: "hello",
    createdAt: AT,
  });
}

function assistantText(): string | undefined {
  return useChatStore.getState().messages.find((message) => message.id === ASSISTANT)?.text;
}

beforeEach(() => {
  useChatStore.setState({ threadId: null, messages: [], streaming: null, lastError: null });
});

describe("chat store: a normal turn", () => {
  it("applies started → delta ×3 → usage → done and clears the stream", () => {
    beginTurn();
    const store = useChatStore.getState();

    store.applyEvent(started());
    expect(useChatStore.getState().streaming).toEqual({ generationId: GENERATION, seq: 0 });

    store.applyEvent(delta(1, "Hello"));
    store.applyEvent(delta(2, " from"));
    store.applyEvent(delta(3, " the mock."));
    store.applyEvent({
      type: "usage",
      generationId: GENERATION,
      seq: 4,
      promptTokens: 12,
      completionTokens: 6,
      costMicrocents: 0,
    });
    store.applyEvent({ type: "done", generationId: GENERATION, seq: 5, finishReason: "stop" });

    const state = useChatStore.getState();
    expect(state.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "hello"],
      ["assistant", "Hello from the mock."],
    ]);
    expect(state.streaming).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it("adopts a started event that beats chat.send's response, keeping turn order", () => {
    // Main emits `started` before the invoke resolves, so the placeholder can exist
    // before the renderer knows the ids.
    useChatStore.getState().applyEvent(started());
    beginTurn();

    const state = useChatStore.getState();
    expect(state.messages.map((message) => message.id)).toEqual([USER, ASSISTANT]);
    expect(state.streaming).toEqual({ generationId: GENERATION, seq: 0 });
  });
});

describe("chat store: idempotency", () => {
  it("ignores a duplicate seq instead of appending its text twice", () => {
    beginTurn();
    const store = useChatStore.getState();

    store.applyEvent(started());
    store.applyEvent(delta(1, "Hello"));
    store.applyEvent(delta(1, "Hello"));
    store.applyEvent(delta(2, " there"));

    expect(assistantText()).toBe("Hello there");
  });

  it("ignores an out-of-order event that arrives after a higher seq", () => {
    beginTurn();
    const store = useChatStore.getState();

    store.applyEvent(started());
    store.applyEvent(delta(2, "second"));
    store.applyEvent(delta(1, "first"));

    expect(assistantText()).toBe("second");
  });

  it("ignores every event for a generation this thread never started", () => {
    beginTurn();
    const store = useChatStore.getState();
    store.applyEvent(started());

    store.applyEvent(delta(1, "mine"));
    store.applyEvent(delta(1, "someone else's", OTHER_GENERATION));

    expect(assistantText()).toBe("mine");
  });
});

describe("chat store: failure and stop", () => {
  it("records the contract's error code on the message and in lastError", () => {
    beginTurn();
    const store = useChatStore.getState();
    store.applyEvent(started());
    store.applyEvent(delta(1, "partial"));

    store.applyEvent({
      type: "error",
      generationId: GENERATION,
      seq: 2,
      error: { code: "BUDGET_EXCEEDED", message: "Monthly budget exhausted. Top up to continue." },
    });

    const state = useChatStore.getState();
    expect(state.lastError).toEqual({
      code: "BUDGET_EXCEEDED",
      message: "Monthly budget exhausted. Top up to continue.",
    });
    expect(state.streaming).toBeNull();
    expect(state.messages.find((message) => message.id === ASSISTANT)?.errorCode).toBe(
      "BUDGET_EXCEEDED",
    );
    // Whatever streamed before the failure is still on screen.
    expect(assistantText()).toBe("partial");
  });

  it("clears streaming on an explicit stop", () => {
    beginTurn();
    const store = useChatStore.getState();
    store.applyEvent(started());
    store.applyEvent(delta(1, "half"));

    store.clearStreaming(GENERATION);
    expect(useChatStore.getState().streaming).toBeNull();
  });

  it("leaves another generation's stream alone when stopping this one", () => {
    beginTurn();
    const store = useChatStore.getState();
    store.applyEvent(started());

    store.clearStreaming(OTHER_GENERATION);
    expect(useChatStore.getState().streaming).not.toBeNull();
  });

  it("clears lastError when the next turn starts", () => {
    useChatStore.getState().setLastError({ code: "INTERNAL", message: "boom" });
    beginTurn();
    expect(useChatStore.getState().lastError).toBeNull();
  });
});

describe("chat store: reasoning and tools", () => {
  it("accumulates reasoning separately from the answer text", () => {
    beginTurn();
    const store = useChatStore.getState();
    store.applyEvent(started());
    store.applyEvent({
      type: "reasoning",
      generationId: GENERATION,
      seq: 1,
      text: "The user wants",
    });
    store.applyEvent({
      type: "reasoning",
      generationId: GENERATION,
      seq: 2,
      text: " the short answer.",
    });
    store.applyEvent(delta(3, "Four."));

    const message = useChatStore.getState().messages.find((entry) => entry.id === ASSISTANT);
    expect(message?.reasoning).toBe("The user wants the short answer.");
    expect(message?.text).toBe("Four.");
  });

  it("pairs a tool result with its call by id", () => {
    beginTurn();
    const store = useChatStore.getState();
    store.applyEvent(started());
    store.applyEvent({
      type: "toolCall",
      generationId: GENERATION,
      seq: 1,
      callId: "call_1",
      name: "get_weather",
      args: { city: "Lisbon" },
    });
    store.applyEvent({
      type: "toolResult",
      generationId: GENERATION,
      seq: 2,
      callId: "call_1",
      ok: true,
      result: { temperature: 21 },
    });

    const message = useChatStore.getState().messages.find((entry) => entry.id === ASSISTANT);
    expect(message?.toolCalls).toEqual([
      {
        callId: "call_1",
        name: "get_weather",
        args: { city: "Lisbon" },
        ok: true,
        result: { temperature: 21 },
      },
    ]);
  });
});

describe("chat store: history", () => {
  it("hydrates a restored thread and can forget it", () => {
    useChatStore.getState().hydrate(THREAD, [
      {
        id: USER,
        role: "user",
        text: "hi",
        reasoning: "",
        toolCalls: [],
        createdAt: AT,
        generationId: null,
        errorCode: null,
        lastSeq: 0,
      },
      {
        id: ASSISTANT,
        role: "assistant",
        text: "Hello from the mock.",
        reasoning: "",
        toolCalls: [],
        createdAt: AT,
        generationId: GENERATION,
        errorCode: null,
        lastSeq: 0,
      },
    ]);

    let state = useChatStore.getState();
    expect(state.threadId).toBe(THREAD);
    expect(state.messages.map((message) => message.text)).toEqual(["hi", "Hello from the mock."]);

    state.forgetThread();
    state = useChatStore.getState();
    expect(state.threadId).toBeNull();
    expect(state.messages).toEqual([]);
  });
});

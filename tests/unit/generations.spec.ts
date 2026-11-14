import { randomUUID } from "node:crypto";
import type { GenerationEvent } from "@shared/ipc-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GenerationBus } from "../../src/main/api/bus.js";
import { MOCK_BASE_URL, resolveBaseUrl } from "../../src/main/api/client.js";
import {
  type ChatSendResponse,
  GenerationService,
  type GenerationSink,
} from "../../src/main/api/generations.js";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";
import { AppError } from "../../src/main/errors.js";

/**
 * The inference layer without the network and without a clock.
 *
 * These tests are about the two promises the orchestrator makes that a mock
 * server cannot check cheaply: the event stream is ordered and single-identity,
 * and every turn leaves a terminal record even when it fails.
 */

interface Waiter {
  predicate: (event: GenerationEvent) => boolean;
  resolve: (event: GenerationEvent) => void;
}

/**
 * A sink that records events and can be awaited. Events are emitted
 * synchronously, so a waiter registered after the fact still resolves instead of
 * hanging on an event that has already gone by.
 */
class EventLog {
  readonly events: GenerationEvent[] = [];
  private readonly waiters: Waiter[] = [];

  readonly sink: GenerationSink = (event) => {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  };

  waitFor(predicate: (event: GenerationEvent) => boolean): Promise<GenerationEvent> {
    const seen = this.events.find(predicate);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }

  terminal(): Promise<GenerationEvent> {
    return this.waitFor((event) => event.type === "done" || event.type === "error");
  }
}

function sseBody(frames: readonly string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join("");
}

/** A fetch that answers with one fixed SSE body, however it is called. */
function stubFetch(frames: readonly string[]): typeof fetch {
  return async () =>
    new Response(sseBody(frames), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
}

const TEXT_FRAMES = [
  '{"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
  '{"choices":[{"index":0,"delta":{"content":"Hello"}}]}',
  '{"choices":[{"index":0,"delta":{"content":" world"}}]}',
  '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
  "[DONE]",
];

interface Rig {
  conn: Db;
  db: DrizzleDb;
  service: GenerationService;
  bus: GenerationBus;
  log: EventLog;
}

let rig: Rig | null = null;

function createRig(overrides: {
  fetchImpl: typeof fetch;
  clock?: () => number;
  checkpointIntervalMs?: number;
}): Rig {
  const conn = openDatabase(":memory:");
  const db = createDb(conn);
  const bus = new GenerationBus();
  const log = new EventLog();
  const service = new GenerationService({
    db,
    bus,
    resolveConfig: async () => ({ baseUrl: "http://inference.test", apiKey: null }),
    fetchImpl: overrides.fetchImpl,
    ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
    ...(overrides.checkpointIntervalMs === undefined
      ? {}
      : { checkpointIntervalMs: overrides.checkpointIntervalMs }),
  });

  rig = { conn, db, service, bus, log };
  return rig;
}

function send(
  subject: GenerationService,
  text: string,
  sink: GenerationSink,
): Promise<ChatSendResponse> {
  return subject.send({ threadId: null, text, model: "mock/text" }, sink);
}

function messageText(conn: Db, messageId: string): string | undefined {
  const row = conn.prepare("SELECT text FROM messages WHERE id = ?").get(messageId) as
    | { text: string }
    | undefined;
  return row?.text;
}

interface GenerationRow {
  finish_reason: string | null;
  error_code: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  ended_at: string | null;
}

function generationRow(conn: Db, generationId: string): GenerationRow | undefined {
  return conn
    .prepare(
      "SELECT finish_reason, error_code, prompt_tokens, completion_tokens, ended_at FROM generations WHERE id = ?",
    )
    .get(generationId) as GenerationRow | undefined;
}

/** A stream whose chunks this test decides when to deliver. */
function controlledStream(): { stream: ReadableStream<Uint8Array>; push: (frame: string) => void } {
  const encoder = new TextEncoder();
  let deliver: (text: string) => void = () => {
    throw new Error("stream controller was not initialised");
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Assigned synchronously: ReadableStream calls start() before returning.
      deliver = (text) => controller.enqueue(encoder.encode(text));
    },
  });

  return { stream, push: (frame) => deliver(`data: ${frame}\n\n`) };
}

beforeEach(() => {
  rig = null;
});

afterEach(() => {
  closeDatabase();
});

describe("GenerationService", () => {
  it("numbers events monotonically under one generationId and ends with done", async () => {
    const { service, log, conn, bus } = createRig({ fetchImpl: stubFetch(TEXT_FRAMES) });

    const sent = await send(service, "hi", log.sink);
    const terminal = await log.terminal();

    expect(terminal.type).toBe("done");
    expect(terminal).toMatchObject({ finishReason: "stop" });

    // Ordering is `seq`, not arrival order: every event is numbered from zero
    // with no gaps, and every event belongs to the generation that was returned.
    expect(log.events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(log.events.map((event) => event.generationId))).toEqual(
      new Set([sent.generationId]),
    );
    expect(log.events[0]).toMatchObject({ type: "started", threadId: sent.threadId });

    expect(messageText(conn, sent.assistantMessageId)).toBe("Hello world");
    expect(generationRow(conn, sent.generationId)).toMatchObject({
      finish_reason: "stop",
      error_code: null,
      prompt_tokens: 5,
      completion_tokens: 2,
    });
    expect(generationRow(conn, sent.generationId)?.ended_at).not.toBeNull();

    // The service releases its subscriber when the turn ends; a bus that keeps
    // the sink alive would leak one entry per message for the life of the app.
    // Cleanup rides on the turn's promise settling, which is one microtask turn
    // behind the terminal event, so let the queue drain first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bus.listenerCount(sent.generationId)).toBe(0);
  });

  it("persists a terminal state when the request fails outright", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "upstream is down" } }), { status: 500 });

    const { service, log, conn } = createRig({ fetchImpl });

    const sent = await send(service, "hi", log.sink);
    const terminal = await log.terminal();

    expect(terminal.type).toBe("error");
    expect(terminal).toMatchObject({
      error: { code: "UPSTREAM_ERROR", message: "upstream is down" },
    });
    expect(log.events.some((event) => event.type === "done")).toBe(false);

    // A failed turn is still a finished row: it must not look resumable, or the
    // next launch would try to continue a request that will never arrive.
    expect(generationRow(conn, sent.generationId)).toMatchObject({
      finish_reason: null,
      error_code: "UPSTREAM_ERROR",
    });
    expect(generationRow(conn, sent.generationId)?.ended_at).not.toBeNull();
  });

  it("treats a well-framed stream with no terminal frame as truncated", async () => {
    const { service, log, conn } = createRig({
      fetchImpl: stubFetch([
        '{"choices":[{"index":0,"delta":{"content":"half an"}}]}',
        '{"choices":[{"index":0,"delta":{"content":" answer"}}]}',
      ]),
    });

    const sent = await send(service, "hi", log.sink);
    const terminal = await log.terminal();

    expect(terminal).toMatchObject({ type: "error", error: { code: "UPSTREAM_TRUNCATED" } });
    expect(log.events.some((event) => event.type === "done")).toBe(false);

    // What did arrive is kept: it is the only part of the answer that exists.
    expect(messageText(conn, sent.assistantMessageId)).toBe("half an answer");
    expect(generationRow(conn, sent.generationId)?.error_code).toBe("UPSTREAM_TRUNCATED");
  });

  it("checkpoints at most every interval and once at the end", async () => {
    let now = 1_000;
    const { stream, push } = controlledStream();
    const fetchImpl: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const { service, log, conn } = createRig({
      fetchImpl,
      clock: () => now,
      checkpointIntervalMs: 250,
    });

    const sent = await send(service, "hi", log.sink);
    await log.waitFor((event) => event.type === "started");

    // First delta at t=1000: the interval has not elapsed, so nothing is written.
    push('{"choices":[{"index":0,"delta":{"content":"aaa"}}]}');
    await log.waitFor((event) => event.type === "delta" && event.text === "aaa");
    expect(messageText(conn, sent.assistantMessageId)).toBe("");

    // Second delta at t=1300: 300ms since the last checkpoint, so the whole
    // accumulated text is written, not just the newest fragment.
    now = 1_300;
    push('{"choices":[{"index":0,"delta":{"content":"bbb"}}]}');
    await log.waitFor((event) => event.type === "delta" && event.text === "bbb");
    expect(messageText(conn, sent.assistantMessageId)).toBe("aaabbb");

    // Third delta immediately after: suppressed again.
    push('{"choices":[{"index":0,"delta":{"content":"ccc"}}]}');
    await log.waitFor((event) => event.type === "delta" && event.text === "ccc");
    expect(messageText(conn, sent.assistantMessageId)).toBe("aaabbb");

    push('{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}');
    push("[DONE]");
    await log.terminal();

    // The final flush is unconditional.
    expect(messageText(conn, sent.assistantMessageId)).toBe("aaabbbccc");
  });

  it("rejects an unknown thread before writing anything", async () => {
    const { service, log, conn } = createRig({ fetchImpl: stubFetch(TEXT_FRAMES) });

    const attempt = service.send(
      { threadId: randomUUID(), text: "hi", model: "mock/text" },
      log.sink,
    );

    await expect(attempt).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rows = conn.prepare("SELECT count(*) AS n FROM messages").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("resolveBaseUrl", () => {
  it("prefers the configured base URL and drops its trailing slash", () => {
    expect(
      resolveBaseUrl({ isPackaged: true, env: { CLEON_API_BASE: "https://api.example.com/" } }),
    ).toBe("https://api.example.com");
  });

  it("falls back to the mock server while unpackaged", () => {
    expect(resolveBaseUrl({ isPackaged: false, env: {} })).toBe(MOCK_BASE_URL);
  });

  it("refuses to guess when packaged with nothing configured", () => {
    // A shipped build answering from a localhost fixture would be
    // indistinguishable from a working app.
    try {
      resolveBaseUrl({ isPackaged: true, env: {} });
      expect.unreachable("resolveBaseUrl should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("INTERNAL");
      expect((error as AppError).message).toBe("no inference base URL configured");
    }
  });
});

describe("GenerationBus", () => {
  it("delivers only to subscribers of that generation, until unsubscribed", () => {
    const bus = new GenerationBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe("generation-a", (event) => seen.push(event.type));

    bus.emit({
      type: "delta",
      generationId: "generation-b",
      seq: 0,
      text: "not mine",
    });
    expect(seen).toEqual([]);

    bus.emit({ type: "delta", generationId: "generation-a", seq: 1, text: "mine" });
    expect(seen).toEqual(["delta"]);

    unsubscribe();
    bus.emit({ type: "delta", generationId: "generation-a", seq: 2, text: "after" });
    expect(seen).toEqual(["delta"]);
    expect(bus.listenerCount("generation-a")).toBe(0);
  });
});

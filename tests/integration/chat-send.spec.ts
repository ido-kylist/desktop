import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerationEvent } from "@shared/ipc-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenerationBus } from "../../src/main/api/bus.js";
import { GenerationService, type GenerationSink } from "../../src/main/api/generations.js";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";

/**
 * The whole turn, against the real mock server and a real database.
 *
 * Nothing here is simulated: a child process serves the bytes, `fetch` reads them
 * over a socket, the SSE parser frames them, the service persists into SQLite.
 * The only thing replaced is the credential, because the mock ignores auth by
 * design and the real-key leg belongs to the owner.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
/** Slow enough that a stop lands in the middle of a stream, not after it. */
const FRAME_DELAY_MS = 25;

let server: ChildProcess | undefined;
let base = "";
let tempDir = "";
let conn: Db;
let db: DrizzleDb;

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Reserves a port by holding it, then releasing it for the child to bind. */
async function freePort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(0, "127.0.0.1", resolveListen);
  });

  const address = probe.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;

  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => (error ? rejectClose(error) : resolveClose()));
  });

  if (port === 0) throw new Error("could not reserve a port for the mock server");
  return port;
}

async function waitForHealth(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("mock server did not become healthy");
}

interface Waiter {
  predicate: (event: GenerationEvent) => boolean;
  resolve: (event: GenerationEvent) => void;
}

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
    return new Promise((resolveWaiter) => {
      this.waiters.push({ predicate, resolve: resolveWaiter });
    });
  }

  terminal(): Promise<GenerationEvent> {
    return this.waitFor((event) => event.type === "done" || event.type === "error");
  }
}

function createService(fetchImpl?: typeof fetch): { service: GenerationService; log: EventLog } {
  const log = new EventLog();
  const service = new GenerationService({
    db,
    bus: new GenerationBus(),
    resolveConfig: async () => ({ baseUrl: base, apiKey: null }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  return { service, log };
}

function messageText(messageId: string): string | undefined {
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

function generationRow(generationId: string): GenerationRow | undefined {
  return conn
    .prepare(
      "SELECT finish_reason, error_code, prompt_tokens, completion_tokens, ended_at FROM generations WHERE id = ?",
    )
    .get(generationId) as GenerationRow | undefined;
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  server = spawn(process.execPath, ["mock/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), FRAME_DELAY_MS: String(FRAME_DELAY_MS) },
    stdio: "ignore",
  });
  await waitForHealth();

  tempDir = await mkdtemp(join(tmpdir(), "cleon-d1b-"));
  conn = openDatabase(join(tempDir, "cleon.db"));
  db = createDb(conn);
});

afterAll(async () => {
  server?.kill();
  closeDatabase();
  if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
});

describe("chat.send against the mock server", () => {
  it("persists the turn first and streams the answer to a done event", async () => {
    let atCall: { role: string; text: string }[] | null = null;
    const probingFetch: typeof fetch = async (input, init) => {
      // Read the database at the moment the request is issued: this is the
      // invariant under test, not an incidental side effect.
      atCall = conn.prepare("SELECT role, text FROM messages ORDER BY rowid").all() as {
        role: string;
        text: string;
      }[];
      return fetch(fetchInputUrl(input), init);
    };

    const { service, log } = createService(probingFetch);
    const sent = await service.send(
      { threadId: null, text: "Hello there", model: "mock/text" },
      log.sink,
    );
    const terminal = await log.terminal();

    expect(terminal).toMatchObject({ type: "done", finishReason: "stop" });

    // Both rows existed before the network call: the user's turn and the empty
    // assistant placeholder the checkpoints will fill.
    expect(atCall).not.toBeNull();
    expect(atCall).toContainEqual({ role: "user", text: "Hello there" });
    expect(atCall).toContainEqual({ role: "assistant", text: "" });

    const streamed = log.events.flatMap((event) => (event.type === "delta" ? [event.text] : []));
    expect(streamed.join("")).toBe("Hello from the mock.");
    expect(messageText(sent.assistantMessageId)).toBe("Hello from the mock.");

    expect(generationRow(sent.generationId)).toMatchObject({
      finish_reason: "stop",
      error_code: null,
      prompt_tokens: 12,
      completion_tokens: 6,
    });
    expect(generationRow(sent.generationId)?.ended_at).not.toBeNull();
  });

  it("continues a thread: chains parents and sends the conversation so far", async () => {
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const capturingFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body === "string") requests.push(JSON.parse(init.body));
      return fetch(fetchInputUrl(input), init);
    };

    // A fresh service per turn so each has its own event log.
    const first = createService(capturingFetch);
    const opening = await first.service.send(
      { threadId: null, text: "first question", model: "mock/text" },
      first.log.sink,
    );
    await first.log.terminal();

    const second = createService(capturingFetch);
    const reply = await second.service.send(
      { threadId: opening.threadId, text: "second question", model: "mock/text" },
      second.log.sink,
    );
    const terminal = await second.log.terminal();

    expect(terminal).toMatchObject({ type: "done", finishReason: "stop" });
    expect(reply.threadId).toBe(opening.threadId);

    // History comes from the database, oldest first, and includes the answer that
    // was just streamed and checkpointed.
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Hello from the mock." },
      { role: "user", content: "second question" },
    ]);

    // `messages` is a tree, not a list: each turn hangs under the previous answer.
    const rows = conn
      .prepare("SELECT id, parent_id FROM messages WHERE thread_id = ? ORDER BY rowid")
      .all(opening.threadId) as { id: string; parent_id: string | null }[];
    expect(rows.map((row) => [row.id, row.parent_id])).toEqual([
      [opening.userMessageId, null],
      [opening.assistantMessageId, opening.userMessageId],
      [reply.userMessageId, opening.assistantMessageId],
      [reply.assistantMessageId, reply.userMessageId],
    ]);
  });

  it("emits one toolCall carrying the reassembled argument JSON", async () => {
    const { service, log } = createService();
    const sent = await service.send(
      { threadId: null, text: "weather in Lisbon?", model: "mock/tool" },
      log.sink,
    );
    const terminal = await log.terminal();

    const toolCalls = log.events.filter((event) => event.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      callId: "call_1",
      name: "get_weather",
      // Delivered as two fragments on the wire; only meaningful once joined.
      args: { city: "Lisbon" },
    });
    expect(terminal).toMatchObject({ type: "done", finishReason: "tool_calls" });
    expect(messageText(sent.assistantMessageId)).toBe("Checking the weather.");
  });

  it("maps 402 to BUDGET_EXCEEDED and records the code", async () => {
    const { service, log } = createService();
    const sent = await service.send(
      { threadId: null, text: "expensive", model: "mock/402" },
      log.sink,
    );
    const terminal = await log.terminal();

    if (terminal.type !== "error") throw new Error(`expected an error event, got ${terminal.type}`);
    expect(terminal.error.code).toBe("BUDGET_EXCEEDED");
    expect(terminal.error.message).toBe("Monthly budget exhausted. Top up to continue.");
    expect(log.events.some((event) => event.type === "done")).toBe(false);
    expect(generationRow(sent.generationId)?.error_code).toBe("BUDGET_EXCEEDED");
  });

  it("maps 429 to RATE_LIMITED with the Retry-After header in milliseconds", async () => {
    const { service, log } = createService();
    const sent = await service.send({ threadId: null, text: "again", model: "mock/429" }, log.sink);
    const terminal = await log.terminal();

    if (terminal.type !== "error") throw new Error(`expected an error event, got ${terminal.type}`);
    expect(terminal.error.code).toBe("RATE_LIMITED");
    // The mock sends `retry-after: 7`.
    expect(terminal.error.retryAfterMs).toBeGreaterThanOrEqual(7000);
    expect(terminal.error.retryAfterMs).toBeLessThanOrEqual(7100);
    expect(generationRow(sent.generationId)?.error_code).toBe("RATE_LIMITED");
  });

  it("reports UPSTREAM_TRUNCATED for a stream that stopped mid-sentence", async () => {
    const { service, log } = createService();
    const sent = await service.send(
      { threadId: null, text: "tell me everything", model: "mock/truncated" },
      log.sink,
    );
    const terminal = await log.terminal();

    // The fixture is well-framed and simply stops: truncation has to be decided
    // from what never arrived, not from the parser throwing.
    if (terminal.type !== "error") throw new Error(`expected an error event, got ${terminal.type}`);
    expect(terminal.error.code).toBe("UPSTREAM_TRUNCATED");
    expect(log.events.some((event) => event.type === "done")).toBe(false);
    expect(messageText(sent.assistantMessageId)).toBe("This stream stops mid-");
    expect(generationRow(sent.generationId)?.error_code).toBe("UPSTREAM_TRUNCATED");
  });

  it("stops mid-stream without recording an error", async () => {
    const signals: AbortSignal[] = [];
    const capturingFetch: typeof fetch = (input, init) => {
      if (init?.signal) signals.push(init.signal);
      return fetch(fetchInputUrl(input), init);
    };

    const { service, log } = createService(capturingFetch);

    let generationId: string | null = null;
    const stopped: boolean[] = [];
    const sink: GenerationSink = (event) => {
      log.sink(event);
      if (event.type === "started") generationId = event.generationId;
      // Stop as soon as the first token arrives, while the mock is still writing.
      if (event.type === "delta" && generationId !== null) {
        stopped.push(service.stop(generationId).stopped);
      }
    };

    const sent = await service.send(
      { threadId: null, text: "count to a hundred", model: "mock/text" },
      sink,
    );
    const terminal = await log.terminal();

    expect(stopped).toEqual([true]);
    expect(terminal).toMatchObject({ type: "done", finishReason: "stop" });
    expect(log.events.some((event) => event.type === "error")).toBe(false);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);

    // A stop is a normal end: no error code, no finish reason from the model.
    expect(generationRow(sent.generationId)).toMatchObject({
      finish_reason: null,
      error_code: null,
    });
    expect(generationRow(sent.generationId)?.ended_at).not.toBeNull();

    // Nothing is still running, so a second stop has nothing to abort.
    expect(service.stop(sent.generationId)).toEqual({ stopped: false });
  });
});

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerationEvent } from "@shared/ipc-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenerationBus } from "../../src/main/api/bus.js";
import { GenerationService, type GenerationSink } from "../../src/main/api/generations.js";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";
import { getThread } from "../../src/main/db/repo.js";
import {
  archiveAssistant,
  createAssistant,
  getAssistant,
  listAssistants,
  updateAssistant,
} from "../../src/main/db/repo-assistants.js";
import { createProject } from "../../src/main/db/repo-projects.js";
import { AppError } from "../../src/main/errors.js";

/**
 * D6 assistants, against a real SQLite file and the real mock server.
 *
 * Two things are proven here that a unit test with a fake database cannot:
 *
 *  1. The row survives a round trip through SQLite — REAL temperature included, because
 *     `0` is a legitimate temperature and is exactly the value a truthiness check eats.
 *  2. The assistant **reaches the wire**: the system prompt is the first message, its
 *     variables are expanded from the injected clock, its model is used when the request
 *     does not name one, and its temperature is in the request body.
 *
 * A fresh service per turn, because each generation owns its own bus subscription and
 * event log; the database is shared and is the thing under test.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

/** The instant every prompt expansion in this file is measured against. */
const TEST_NOW = "2026-11-15T19:01:13.331Z";

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

  terminal(): Promise<GenerationEvent> {
    const seen = this.events.find((event) => event.type === "done" || event.type === "error");
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolveWaiter) => {
      this.waiters.push({
        predicate: (event) => event.type === "done" || event.type === "error",
        resolve: resolveWaiter,
      });
    });
  }
}

interface WireBody {
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
}

function createService(): {
  service: GenerationService;
  log: EventLog;
  bodies: WireBody[];
} {
  const log = new EventLog();
  const bodies: WireBody[] = [];

  const capturingFetch: typeof fetch = async (input, init) => {
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as WireBody);
    return fetch(fetchInputUrl(input), init);
  };

  const service = new GenerationService({
    db,
    bus: new GenerationBus(),
    resolveConfig: async () => ({ baseUrl: base, apiKey: null }),
    fetchImpl: capturingFetch,
    // The prompt clock, injected. A constant also means checkpoints only happen at the
    // end, which is irrelevant here and makes the turns finish deterministically.
    clock: () => Date.parse(TEST_NOW),
  });

  return { service, log, bodies };
}

/** Calls the mutator and asserts the specific failure code, not just "it threw". */
function expectAppError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

async function expectRejection(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was rejected`);
}

function countOf(table: "threads" | "messages" | "generations"): number {
  const row = conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  server = spawn(process.execPath, ["mock/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), FRAME_DELAY_MS: "1" },
    stdio: "ignore",
  });
  await waitForHealth();

  tempDir = await mkdtemp(join(tmpdir(), "cleon-d6-assistants-"));
  conn = openDatabase(join(tempDir, "cleon.db"));
  db = createDb(conn);
});

afterAll(async () => {
  server?.kill();
  closeDatabase();
  if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  conn.exec("DELETE FROM generations; DELETE FROM messages; DELETE FROM threads;");
  conn.exec("DELETE FROM assistants; DELETE FROM projects;");
});

describe("assistants CRUD", () => {
  it("creates a row and reads it back with the values it was given", () => {
    const created = createAssistant(db, {
      name: "Reviewer",
      model: "mock/text",
      systemPrompt: "You review code.",
      temperature: 0.2,
    });

    expect(created).toMatchObject({
      name: "Reviewer",
      model: "mock/text",
      systemPrompt: "You review code.",
      temperature: 0.2,
      archivedAt: null,
    });
    expect(created.createdAt).toBe(created.updatedAt);

    // From the database, not from the returned object: this is what a relaunch does.
    expect(getAssistant(db, created.id)).toMatchObject({ name: "Reviewer", temperature: 0.2 });
  });

  it("keeps a temperature of 0 — it is a value, not an absence", () => {
    const created = createAssistant(db, {
      name: "Deterministic",
      model: "mock/text",
      systemPrompt: "",
      temperature: 0,
    });

    expect(created.temperature).toBe(0);
    expect(getAssistant(db, created.id)?.temperature).toBe(0);

    // The update path has the same trap: an omitted temperature leaves the stored 0 alone.
    const updated = updateAssistant(db, { assistantId: created.id, name: "Renamed" });
    expect(updated.temperature).toBe(0);
  });

  it("lists by name and hides archived ones unless asked", () => {
    const zebra = createAssistant(db, {
      name: "Zebra",
      model: "mock/text",
      systemPrompt: "",
      temperature: 0.5,
    });
    const alpha = createAssistant(db, {
      name: "Alpha",
      model: "mock/text",
      systemPrompt: "",
      temperature: 0.5,
    });

    expect(listAssistants(db, { includeArchived: false }).items.map((a) => a.name)).toEqual([
      "Alpha",
      "Zebra",
    ]);
    expect(listAssistants(db, { includeArchived: false }).total).toBe(2);

    archiveAssistant(db, zebra.id);

    expect(listAssistants(db, { includeArchived: false }).items.map((a) => a.id)).toEqual([
      alpha.id,
    ]);
    expect(listAssistants(db, { includeArchived: true }).items.map((a) => a.id)).toContain(
      zebra.id,
    );
  });

  it("patches only the fields it was given and returns the stored row", () => {
    const created = createAssistant(db, {
      name: "Draft",
      model: "mock/text",
      systemPrompt: "Be brief.",
      temperature: 0.9,
    });

    // Backdated, because two writes in the same millisecond are the normal case here and
    // an assertion on "the timestamp moved" must not depend on the clock's resolution.
    conn
      .prepare("UPDATE assistants SET updated_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", created.id);

    const renamed = updateAssistant(db, { assistantId: created.id, name: "Final" });

    expect(renamed).toMatchObject({
      name: "Final",
      model: "mock/text",
      systemPrompt: "Be brief.",
      temperature: 0.9,
    });
    // Every update is a user edit, so the row moves in the list.
    expect(renamed.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("is NOT_FOUND for an id that does not exist, on update and on archive", () => {
    const missing = randomMissingId();
    expectAppError(() => updateAssistant(db, { assistantId: missing, name: "x" }), "NOT_FOUND");
    expectAppError(() => archiveAssistant(db, missing), "NOT_FOUND");
  });

  it("archives instead of deleting, and a second delete is NOT_FOUND", () => {
    const created = createAssistant(db, {
      name: "Keeper",
      model: "mock/text",
      systemPrompt: "Keep me.",
      temperature: 0.1,
    });

    archiveAssistant(db, created.id);

    // The row is still there: a thread that was sent with it keeps a name to resolve.
    const archived = getAssistant(db, created.id);
    expect(archived?.archivedAt).not.toBeNull();
    expect(archived?.systemPrompt).toBe("Keep me.");

    expectAppError(() => archiveAssistant(db, created.id), "NOT_FOUND");
  });
});

describe("an assistant applied to a turn", () => {
  it("prepends the expanded system prompt and uses its model and temperature", async () => {
    const project = createProject(db, "Platform");
    const assistant = createAssistant(db, {
      name: "Navigator",
      model: "mock/text",
      systemPrompt:
        "Date {{date}} at {{time}}. Thread: {{thread_title}}. Project: {{project_name}}.",
      temperature: 0.4,
    });

    const { service, log, bodies } = createService();
    const sent = await service.send(
      // No model on the request: this is the fallback the brief asks for.
      { threadId: null, text: "Where are we?", assistantId: assistant.id, projectId: project.id },
      log.sink,
    );
    expect(await log.terminal()).toMatchObject({ type: "done" });

    const body = bodies[0];
    expect(body).toBeDefined();
    if (body === undefined) return;

    expect(body.model).toBe("mock/text");
    expect(body.temperature).toBe(0.4);
    // The system turn is first, and every variable that has a value is expanded. The
    // thread is brand new, so its title is the database default — not a guess.
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "Date 2026-11-15 at 19:01. Thread: New thread. Project: Platform.",
    });
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "Where are we?" });

    // The thread remembers which assistant it was sent with, so `chat.thread` can
    // report it and a later turn can re-apply it.
    expect(getThread(db, sent.threadId)?.assistantId).toBe(assistant.id);
    expect(getThread(db, sent.threadId)?.projectId).toBe(project.id);
  });

  it("lets the request's model win over the assistant's, keeping its temperature", async () => {
    const assistant = createAssistant(db, {
      name: "Pinned",
      model: "mock/text",
      systemPrompt: "Stay on topic.",
      temperature: 0.25,
    });

    const { service, log, bodies } = createService();
    await service.send(
      { threadId: null, text: "hello", model: "mock/reasoning", assistantId: assistant.id },
      log.sink,
    );
    expect(await log.terminal()).toMatchObject({ type: "done" });

    expect(bodies[0]?.model).toBe("mock/reasoning");
    expect(bodies[0]?.temperature).toBe(0.25);
  });

  it("leaves the user's text alone: variables expand in the system prompt only", async () => {
    const assistant = createAssistant(db, {
      name: "Literal",
      model: "mock/text",
      systemPrompt: "You are a test.",
      temperature: 0.5,
    });

    const { service, log, bodies } = createService();
    await service.send(
      { threadId: null, text: "what is {{date}}?", assistantId: assistant.id },
      log.sink,
    );
    expect(await log.terminal()).toMatchObject({ type: "done" });

    expect(bodies[0]?.messages.at(-1)).toEqual({ role: "user", content: "what is {{date}}?" });
  });

  it("sends no system turn and no temperature when no assistant is picked", async () => {
    const { service, log, bodies } = createService();
    await service.send({ threadId: null, text: "plain", model: "mock/text" }, log.sink);
    expect(await log.terminal()).toMatchObject({ type: "done" });

    expect(bodies[0]?.messages).toEqual([{ role: "user", content: "plain" }]);
    // Absent, not null: a provider that has no temperature field must not receive one.
    expect(bodies[0]?.temperature).toBeUndefined();
  });

  it("refuses a turn with no model at all, before anything is written", async () => {
    const { service, log } = createService();
    const threadsBefore = countOf("threads");
    const messagesBefore = countOf("messages");

    await expectRejection(
      service.send({ threadId: null, text: "no model", model: "" }, log.sink),
      "BAD_REQUEST",
    );

    // A refusal is not a half-written turn: no thread, no messages, no generation.
    expect(countOf("threads")).toBe(threadsBefore);
    expect(countOf("messages")).toBe(messagesBefore);
    expect(log.events).toEqual([]);
  });

  it("refuses an assistant id that does not exist, before anything is written", async () => {
    const { service, log } = createService();
    const threadsBefore = countOf("threads");

    await expectRejection(
      service.send(
        { threadId: null, text: "who?", assistantId: randomMissingId(), projectId: null },
        log.sink,
      ),
      "NOT_FOUND",
    );

    expect(countOf("threads")).toBe(threadsBefore);
    expect(countOf("messages")).toBe(0);
  });

  it("re-applies the thread's assistant when the request does not name one", async () => {
    const assistant = createAssistant(db, {
      name: "Sticky",
      model: "mock/text",
      systemPrompt: "Thread: {{thread_title}}.",
      temperature: 0.6,
    });

    const first = createService();
    const opening = await first.service.send(
      { threadId: null, text: "first", assistantId: assistant.id },
      first.log.sink,
    );
    expect(await first.log.terminal()).toMatchObject({ type: "done" });

    // The second turn names no assistant and no model: both come from the thread's.
    const second = createService();
    await second.service.send({ threadId: opening.threadId, text: "second" }, second.log.sink);
    expect(await second.log.terminal()).toMatchObject({ type: "done" });

    const body = second.bodies[0];
    expect(body?.model).toBe("mock/text");
    expect(body?.temperature).toBe(0.6);
    expect(body?.messages[0]?.role).toBe("system");
    // The system turn is re-sent in front of the history, not duplicated per turn.
    expect(body?.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(body?.messages.at(-1)).toEqual({ role: "user", content: "second" });
  });

  it("takes the assistant away when the request says null", async () => {
    const assistant = createAssistant(db, {
      name: "Removable",
      model: "mock/text",
      systemPrompt: "Be verbose.",
      temperature: 0.8,
    });

    const first = createService();
    const opening = await first.service.send(
      { threadId: null, text: "first", assistantId: assistant.id },
      first.log.sink,
    );
    expect(await first.log.terminal()).toMatchObject({ type: "done" });

    const second = createService();
    await second.service.send(
      { threadId: opening.threadId, text: "second", assistantId: null, model: "mock/text" },
      second.log.sink,
    );
    expect(await second.log.terminal()).toMatchObject({ type: "done" });

    expect(second.bodies[0]?.messages.some((message) => message.role === "system")).toBe(false);
    expect(getThread(db, opening.threadId)?.assistantId).toBeNull();
  });

  it("re-applies the assistant on regenerate, so a variant is answered under the same prompt", async () => {
    const assistant = createAssistant(db, {
      name: "Consistent",
      model: "mock/text",
      systemPrompt: "Answer as a reviewer.",
      temperature: 0.3,
    });

    const first = createService();
    const opening = await first.service.send(
      { threadId: null, text: "review this", assistantId: assistant.id },
      first.log.sink,
    );
    expect(await first.log.terminal()).toMatchObject({ type: "done" });

    const second = createService();
    second.service.regenerate(opening.assistantMessageId, second.log.sink);
    expect(await second.log.terminal()).toMatchObject({ type: "done" });

    const body = second.bodies[0];
    expect(body?.temperature).toBe(0.3);
    expect(body?.messages[0]).toEqual({ role: "system", content: "Answer as a reviewer." });
    // The prompt is the question the first answer got: the user turn, not the answer.
    expect(body?.messages.at(-1)).toEqual({ role: "user", content: "review this" });
  });
});

/** A uuid that is shaped like one and is in no table. */
function randomMissingId(): string {
  return "ffffffff-ffff-4fff-8fff-ffffffffffff";
}

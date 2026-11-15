import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationEvent } from "@shared/ipc-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { GenerationBus } from "../../src/main/api/bus.js";
import { GenerationService, type GenerationSink } from "../../src/main/api/generations.js";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";
import {
  getActivePath,
  getAncestorPath,
  getThreadTree,
  regenerate,
  setActiveVariant,
} from "../../src/main/db/repo.js";
import { AppError } from "../../src/main/errors.js";

/**
 * D3: the message tree and the variant a thread is showing.
 *
 * Two layers are under test, and they fail differently:
 *
 *  - the repository's tree assembly — sibling grouping, ordering, and which leaf the
 *    read claims is active — against a real SQLite file;
 *  - the orchestrator's `regenerate`, with `fetch` stubbed, so the assertion is about
 *    which prompt goes upstream and what lands in the database, not about bytes on a
 *    socket (that is the mock server's job, in `chat-send.spec.ts`).
 */

const THREAD = "11111111-1111-4111-8111-111111111111";
const OTHER_THREAD = "22222222-2222-4222-8222-222222222222";
const U1 = "33333333-3333-4333-8333-333333333333";
const A1 = "44444444-4444-4444-8444-444444444444";
const A2 = "55555555-5555-4555-8555-555555555555";
const A3 = "66666666-6666-4666-8666-666666666666";
const A4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "77777777-7777-4777-8777-777777777777";
const OTHER_MESSAGE = "88888888-8888-4888-8888-888888888888";
const MISSING = "ffffffff-ffff-4fff-8fff-ffffffffffff";

let tempDir = "";
let conn: Db;
let db: DrizzleDb;

interface SeedMessage {
  id: string;
  threadId: string;
  parentId: string | null;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  variantOf?: string | null;
  model?: string | null;
}

/**
 * One thread, three answers to the same question, and a follow-up that hangs under
 * the first one — the smallest tree that has all three properties the UI needs.
 *
 *   u1 ── a1 ── u2        (a1 was answered, u2 continued that branch)
 *     ├── a2              (a1, regenerated)
 *     └── a3              (a2, regenerated)
 *
 * a2 and a3 share a `created_at` on purpose: a regenerate writes back to back, so the
 * ordering has to fall to insertion order rather than to the clock.
 */
const SEED: SeedMessage[] = [
  {
    id: U1,
    threadId: THREAD,
    parentId: null,
    role: "user",
    text: "the first question",
    createdAt: "2026-01-01T00:00:00.000Z",
    model: "mock/text",
  },
  {
    id: A1,
    threadId: THREAD,
    parentId: U1,
    role: "assistant",
    text: "the first answer",
    createdAt: "2026-01-01T00:00:01.000Z",
    model: "mock/text",
  },
  {
    id: A2,
    threadId: THREAD,
    parentId: U1,
    role: "assistant",
    text: "the second answer",
    createdAt: "2026-01-01T00:00:02.000Z",
    variantOf: A1,
    model: "mock/text",
  },
  {
    id: A3,
    threadId: THREAD,
    parentId: U1,
    role: "assistant",
    text: "the third answer",
    createdAt: "2026-01-01T00:00:02.000Z",
    variantOf: A2,
    model: "mock/text",
  },
  {
    id: U2,
    threadId: THREAD,
    parentId: A1,
    role: "user",
    text: "a follow-up on the first branch",
    createdAt: "2026-01-01T00:00:03.000Z",
    model: "mock/text",
  },
];

function insertMessages(messages: readonly SeedMessage[]): void {
  const insert = conn.prepare(
    "INSERT INTO messages (id, thread_id, parent_id, role, text, model, variant_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const message of messages) {
    insert.run(
      message.id,
      message.threadId,
      message.parentId,
      message.role,
      message.text,
      message.model ?? null,
      message.variantOf ?? null,
      message.createdAt,
    );
  }
}

function reseed(): void {
  // Messages first: their delete trigger clears the FTS index, whereas deleting the
  // threads and letting the cascade run would leave rows behind (SQLite fires the
  // cascade's delete triggers only with `recursive_triggers` on, which this app does
  // not enable).
  conn.exec(`
    DELETE FROM generations;
    DELETE FROM content_blocks;
    DELETE FROM messages;
    DELETE FROM threads;
    DELETE FROM messages_fts;
  `);

  const insertThread = conn.prepare(
    "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  insertThread.run(THREAD, "Branched", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:03.000Z");
  insertThread.run(
    OTHER_THREAD,
    "Elsewhere",
    "2026-01-02T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
  );

  insertMessages(SEED);
  insertMessages([
    {
      id: OTHER_MESSAGE,
      threadId: OTHER_THREAD,
      parentId: null,
      role: "user",
      text: "somewhere else",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ]);

  // Only the first answer carries a generation row with usage; the others stand in
  // for messages whose meter is unknown, which the contract allows.
  conn
    .prepare(
      "INSERT INTO generations (id, thread_id, message_id, model, prompt_tokens, completion_tokens, cost_microcents, finish_reason, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "99999999-9999-4999-8999-999999999999",
      THREAD,
      A1,
      "mock/text",
      11,
      7,
      1234,
      "stop",
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
    );
}

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

function pathIds(messages: readonly { id: string }[]): string[] {
  return messages.map((message) => message.id);
}

function loadTree(): NonNullable<ReturnType<typeof getThreadTree>> {
  const tree = getThreadTree(db, THREAD);
  if (tree === null) throw new Error("fixture thread is missing");
  return tree;
}

function variantSets(): (string[] | undefined)[] {
  const tree = loadTree();
  return [A1, A2, A3].map((id) => tree.messages.find((message) => message.id === id)?.variants);
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
    return new Promise((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }

  terminal(): Promise<GenerationEvent> {
    return this.waitFor((event) => event.type === "done" || event.type === "error");
  }
}

const TEXT_FRAMES = [
  '{"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
  '{"choices":[{"index":0,"delta":{"content":"Regenerated"}}]}',
  '{"choices":[{"index":0,"delta":{"content":" answer"}}]}',
  '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
  "[DONE]",
];

interface SentRequest {
  messages: { role: string; content: string }[];
}

/**
 * A service over a stubbed transport that records the prompt it was given — the seam
 * this file is about. Socket-level behaviour is covered by the mock server suite.
 */
function createService(sent: SentRequest[]): GenerationService {
  const stub: typeof fetch = async (_input, init) => {
    if (typeof init?.body === "string") sent.push(JSON.parse(init.body));
    const body = TEXT_FRAMES.map((frame) => `data: ${frame}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  return new GenerationService({
    db,
    bus: new GenerationBus(),
    resolveConfig: async () => ({ baseUrl: "http://stub.invalid", apiKey: null }),
    fetchImpl: stub,
  });
}

interface MessageRow {
  thread_id: string;
  parent_id: string | null;
  role: string;
  text: string;
  model: string | null;
  variant_of: string | null;
}

function messageRow(messageId: string): MessageRow | undefined {
  return conn
    .prepare(
      "SELECT thread_id, parent_id, role, text, model, variant_of FROM messages WHERE id = ?",
    )
    .get(messageId) as MessageRow | undefined;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cleon-d3-"));
  conn = openDatabase(join(tempDir, "cleon.db"));
  db = createDb(conn);
});

afterAll(async () => {
  closeDatabase();
  if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  reseed();
});

describe("sibling grouping", () => {
  it("groups variants by parent and includes every sibling, itself included", () => {
    const tree = loadTree();
    const byId = new Map(tree.messages.map((message) => [message.id, message]));

    // The "2 / 3" affordance: each answer to the same question sees the same set.
    expect(variantSets()).toEqual([
      [A1, A2, A3],
      [A1, A2, A3],
      [A1, A2, A3],
    ]);

    // A message with no siblings is its own group, not an empty one.
    expect(byId.get(U1)?.variants).toEqual([U1]);
    expect(byId.get(U2)?.variants).toEqual([U2]);
  });

  it("keeps parents and the replaced-message pointer separate", () => {
    const tree = loadTree();
    const byId = new Map(tree.messages.map((message) => [message.id, message]));

    expect(byId.get(U1)?.parentId).toBeNull();
    expect(byId.get(A1)?.parentId).toBe(U1);
    expect(byId.get(A2)?.parentId).toBe(U1);
    expect(byId.get(A3)?.parentId).toBe(U1);
    expect(byId.get(U2)?.parentId).toBe(A1);

    // Grouping is by parent; `variantOf` only records which message was replaced.
    expect(byId.get(A1)?.variantOf).toBeNull();
    expect(byId.get(A2)?.variantOf).toBe(A1);
    expect(byId.get(A3)?.variantOf).toBe(A2);
  });

  it("orders siblings by creation time, and by insertion when the clock ties", () => {
    // a2 and a3 share a `created_at`: only insertion order can separate them, and it
    // must, because a regenerate writes both rows in the same millisecond.
    expect(variantSets()).toEqual([
      [A1, A2, A3],
      [A1, A2, A3],
      [A1, A2, A3],
    ]);

    // a4 is inserted last but created *between* a1 and a2, so it has to sort by its
    // timestamp rather than by its row. This is what separates the two rules.
    insertMessages([
      {
        id: A4,
        threadId: THREAD,
        parentId: U1,
        role: "assistant",
        text: "an answer created between the first and the second",
        createdAt: "2026-01-01T00:00:01.500Z",
        variantOf: A1,
      },
    ]);
    expect(variantSets()).toEqual([
      [A1, A4, A2, A3],
      [A1, A4, A2, A3],
      [A1, A4, A2, A3],
    ]);

    const chronological = loadTree().messages.map((message) => message.id);
    expect(chronological).toEqual([U1, A1, A4, A2, A3, U2]);
  });

  it("reports usage only for messages that have a generation row", () => {
    const tree = loadTree();
    const byId = new Map(tree.messages.map((message) => [message.id, message]));

    expect(byId.get(A1)?.usage).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      costMicrocents: 1234,
    });
    expect(byId.get(A1)?.generationId).toBe("99999999-9999-4999-8999-999999999999");
    expect(byId.get(A2)?.usage).toBeNull();
    expect(byId.get(A2)?.generationId).toBeNull();
    expect(byId.get(U1)?.usage).toBeNull();
  });

  it("produces uuid and ISO-datetime values the contract will accept", () => {
    const tree = loadTree();
    for (const message of tree.messages) {
      expect(z.uuid().safeParse(message.id).success).toBe(true);
      expect(z.iso.datetime().safeParse(message.createdAt).success).toBe(true);
      for (const variantId of message.variants) {
        expect(z.uuid().safeParse(variantId).success).toBe(true);
      }
    }
    expect(z.iso.datetime().safeParse(tree.thread.updatedAt).success).toBe(true);
  });

  it("is null for a thread that does not exist", () => {
    expect(getThreadTree(db, MISSING)).toBeNull();
  });
});

describe("active-path resolution", () => {
  it("follows the newest leaf when no variant was ever selected", () => {
    expect(loadTree().activeLeafId).toBeNull();
    expect(pathIds(getActivePath(db, THREAD))).toEqual([U1, A1, U2]);
  });

  it("follows the selected leaf once one is set", () => {
    setActiveVariant(db, THREAD, A2);

    // The selection is a view of the tree, not a rewrite of it: the follow-up that
    // hangs under the other branch is still there, it is just not on this path.
    expect(loadTree().activeLeafId).toBe(A2);
    expect(pathIds(getActivePath(db, THREAD))).toEqual([U1, A2]);
  });

  it("returns root to leaf for any message, not only for a leaf", () => {
    expect(pathIds(getAncestorPath(db, THREAD, U1))).toEqual([U1]);
    expect(pathIds(getAncestorPath(db, THREAD, A3))).toEqual([U1, A3]);
    expect(pathIds(getAncestorPath(db, THREAD, U2))).toEqual([U1, A1, U2]);
    expect(getAncestorPath(db, THREAD, MISSING)).toEqual([]);
    expect(getActivePath(db, MISSING)).toEqual([]);
  });

  it("ignores a remembered leaf that was deleted, falling back to the newest live one", () => {
    setActiveVariant(db, THREAD, U2);
    conn
      .prepare("UPDATE messages SET deleted_at = ? WHERE id = ?")
      .run("2026-01-05T00:00:00.000Z", U2);

    // Null, not a dangling id: the renderer is told to follow the newest leaf rather
    // than being handed a message that is not in the response.
    expect(loadTree().activeLeafId).toBeNull();
    expect(pathIds(getActivePath(db, THREAD))).toEqual([U1, A3]);
  });

  it("terminates on a parent cycle instead of hanging the main process", () => {
    conn.prepare("UPDATE messages SET parent_id = ? WHERE id = ?").run(A2, A1);
    conn.prepare("UPDATE messages SET parent_id = ? WHERE id = ?").run(A1, A2);
    setActiveVariant(db, THREAD, A1);

    const path = pathIds(getActivePath(db, THREAD));
    // The walk stops at the first repeat: a corrupt tree degrades to a short path.
    expect(path).toHaveLength(2);
    expect(path).toEqual(expect.arrayContaining([A1, A2]));
  });
});

describe("chat.setActiveVariant", () => {
  it("is NOT_FOUND for a message in another thread", () => {
    expectAppError(() => setActiveVariant(db, THREAD, OTHER_MESSAGE), "NOT_FOUND");
    expect(loadTree().activeLeafId).toBeNull();
  });

  it("is NOT_FOUND for a message that does not exist", () => {
    expectAppError(() => setActiveVariant(db, THREAD, MISSING), "NOT_FOUND");
  });

  it("is NOT_FOUND for a thread that does not exist", () => {
    expectAppError(() => setActiveVariant(db, MISSING, A1), "NOT_FOUND");
  });

  it("is NOT_FOUND for a soft-deleted message", () => {
    conn
      .prepare("UPDATE messages SET deleted_at = ? WHERE id = ?")
      .run("2026-01-05T00:00:00.000Z", A3);
    expectAppError(() => setActiveVariant(db, THREAD, A3), "NOT_FOUND");
  });

  it("does not reorder the sidebar: selecting a variant is not an edit", () => {
    const before = conn.prepare("SELECT updated_at FROM threads WHERE id = ?").get(THREAD) as {
      updated_at: string;
    };
    setActiveVariant(db, THREAD, A2);
    const after = conn.prepare("SELECT updated_at FROM threads WHERE id = ?").get(THREAD) as {
      updated_at: string;
    };
    expect(after.updated_at).toBe(before.updated_at);
  });
});

describe("regenerate", () => {
  it("adds a sibling under the same parent and starts a generation for it", () => {
    const result = regenerate(db, A1);

    expect(result.threadId).toBe(THREAD);
    // The question being answered again, not the answer being replaced.
    expect(result.userMessageId).toBe(U1);

    expect(messageRow(result.assistantMessageId)).toEqual({
      thread_id: THREAD,
      parent_id: U1,
      role: "assistant",
      text: "",
      model: "mock/text",
      variant_of: A1,
    });

    const generation = conn
      .prepare(
        "SELECT thread_id, message_id, model, finish_reason, ended_at FROM generations WHERE id = ?",
      )
      .get(result.generationId) as
      | {
          thread_id: string;
          message_id: string;
          model: string;
          finish_reason: string | null;
          ended_at: string | null;
        }
      | undefined;
    expect(generation).toEqual({
      thread_id: THREAD,
      message_id: result.assistantMessageId,
      model: "mock/text",
      finish_reason: null,
      ended_at: null,
    });

    // The original answer is untouched: branching keeps the evidence.
    expect(messageRow(A1)?.text).toBe("the first answer");
  });

  it("makes the new answer the active variant, so the next turn continues from it", () => {
    const result = regenerate(db, A1);

    expect(loadTree().activeLeafId).toBe(result.assistantMessageId);
    expect(pathIds(getActivePath(db, THREAD))).toEqual([U1, result.assistantMessageId]);

    const tree = loadTree();
    expect(tree.messages.find((message) => message.id === A1)?.variants).toEqual([
      A1,
      A2,
      A3,
      result.assistantMessageId,
    ]);
  });

  it("refuses a message that is not an assistant turn", () => {
    expectAppError(() => regenerate(db, U1), "BAD_REQUEST");
  });

  it("refuses an id that is not a message", () => {
    expectAppError(() => regenerate(db, MISSING), "BAD_REQUEST");
  });

  it("refuses a soft-deleted message", () => {
    conn
      .prepare("UPDATE messages SET deleted_at = ? WHERE id = ?")
      .run("2026-01-05T00:00:00.000Z", A2);
    expectAppError(() => regenerate(db, A2), "BAD_REQUEST");
  });
});

describe("GenerationService.regenerate", () => {
  it("streams the new variant, with the ancestor path as its prompt", async () => {
    const sent: SentRequest[] = [];
    const log = new EventLog();
    const service = createService(sent);

    const result = service.regenerate(A1, log.sink);
    const terminal = await log.terminal();

    expect(terminal).toMatchObject({ type: "done", finishReason: "stop" });
    expect(log.events.some((event) => event.type === "delta")).toBe(true);

    // The prompt is the question alone: the answer being replaced is not in it, and
    // neither is the follow-up that hangs under it.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages).toEqual([{ role: "user", content: "the first question" }]);

    expect(messageRow(result.assistantMessageId)?.text).toBe("Regenerated answer");

    const generation = conn
      .prepare("SELECT finish_reason, error_code FROM generations WHERE id = ?")
      .get(result.generationId) as
      | { finish_reason: string | null; error_code: string | null }
      | undefined;
    expect(generation).toEqual({ finish_reason: "stop", error_code: null });
  });

  it("propagates a refusal before anything is written or streamed", () => {
    const sent: SentRequest[] = [];
    const log = new EventLog();
    const service = createService(sent);

    expectAppError(() => service.regenerate(U1, log.sink), "BAD_REQUEST");
    expect(sent).toEqual([]);
    expect(log.events).toEqual([]);
  });
});

describe("send after a variant switch", () => {
  it("hangs the next turn under the selected variant and prompts with its path", async () => {
    setActiveVariant(db, THREAD, A2);

    const sent: SentRequest[] = [];
    const log = new EventLog();
    const service = createService(sent);

    const sentTurn = await service.send(
      { threadId: THREAD, text: "a new question", model: "mock/text" },
      log.sink,
    );
    await log.terminal();

    // Hanging under the newest message would have parented this turn under u2, on the
    // branch the user switched away from.
    expect(messageRow(sentTurn.userMessageId)?.parent_id).toBe(A2);
    expect(sent[0]?.messages).toEqual([
      { role: "user", content: "the first question" },
      { role: "assistant", content: "the second answer" },
      { role: "user", content: "a new question" },
    ]);
  });
});

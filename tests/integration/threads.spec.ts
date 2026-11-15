import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase, schemaVersion } from "../../src/main/db/index.js";
import {
  listThreads,
  softDeleteThread,
  type UpdateThreadInput,
  updateThread,
} from "../../src/main/db/repo.js";
import { AppError } from "../../src/main/errors.js";
import { contracts } from "../../src/shared/ipc-contract";

/**
 * D2 against a real SQLite file: the sidebar read, the search read, and the two
 * writes that maintain them.
 *
 * Nothing is mocked. FTS5, `bm25()`, `snippet()`, `LIMIT/OFFSET` and `RETURNING`
 * are all database behaviour, and a mock would happily agree with a query that the
 * database rejects — which is exactly what happened while writing the search: the
 * auxiliary functions cannot live under `GROUP BY` or in a correlated subquery.
 *
 * Fixtures are inserted with explicit timestamps. The reads under test are ordered
 * by those timestamps, so the assertions must not depend on how fast the test runs.
 */

const T = {
  pinned: "aaaaaaa1-1111-4111-8111-111111111111",
  recent: "bbbbbbb2-2222-4222-8222-222222222222",
  archived: "ccccccc3-3333-4333-8333-333333333333",
  deleted: "ddddddd4-4444-4444-8444-444444444444",
  older: "eeeeeee5-5555-4555-8555-555555555555",
} as const;

interface SeedMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

interface SeedThread {
  id: string;
  title: string;
  updatedAt: string;
  pinned?: boolean;
  archivedAt?: string | null;
  deletedAt?: string | null;
  messages: SeedMessage[];
}

function uuidTail(prefix: string): string {
  // Deterministic, but still shaped like a v4 uuid so the contract accepts it.
  return `${prefix}-0000-4000-8000-000000000000`.slice(0, 36);
}

const SEED: SeedThread[] = [
  {
    id: T.pinned,
    title: "Pinned, oldest edit",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pinned: true,
    messages: [
      {
        id: uuidTail("10000001"),
        role: "user",
        text: "pinned message about nothing",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  {
    id: T.recent,
    title: "Most recently edited",
    updatedAt: "2026-03-10T00:00:00.000Z",
    messages: [
      {
        id: uuidTail("20000001"),
        role: "user",
        text: "alpha beta in the first message",
        createdAt: "2026-03-10T00:00:00.000Z",
      },
      {
        id: uuidTail("20000002"),
        role: "assistant",
        text: "gamma delta in the answer",
        createdAt: "2026-03-10T00:00:01.000Z",
      },
    ],
  },
  {
    id: T.older,
    title: "Older, not matching",
    updatedAt: "2026-02-01T00:00:00.000Z",
    messages: [
      {
        id: uuidTail("30000001"),
        role: "user",
        text: "nothing relevant here",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ],
  },
  {
    id: T.archived,
    title: "Archived",
    updatedAt: "2026-03-11T00:00:00.000Z",
    archivedAt: "2026-03-12T00:00:00.000Z",
    messages: [
      {
        id: uuidTail("40000001"),
        role: "user",
        text: "alpha inside an archived thread",
        createdAt: "2026-03-11T00:00:00.000Z",
      },
    ],
  },
  {
    id: T.deleted,
    title: "Soft deleted",
    updatedAt: "2026-03-13T00:00:00.000Z",
    deletedAt: "2026-03-14T00:00:00.000Z",
    messages: [
      {
        id: uuidTail("50000001"),
        role: "user",
        text: "alpha inside a deleted thread",
        createdAt: "2026-03-13T00:00:00.000Z",
      },
    ],
  },
];

let tempDir = "";
let conn: Db;
let db: DrizzleDb;

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
    "INSERT INTO threads (id, title, pinned, archived_at, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMessage = conn.prepare(
    "INSERT INTO messages (id, thread_id, parent_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );

  for (const thread of SEED) {
    insertThread.run(
      thread.id,
      thread.title,
      thread.pinned === true ? 1 : 0,
      thread.archivedAt ?? null,
      thread.updatedAt,
      thread.updatedAt,
      thread.deletedAt ?? null,
    );
    let parentId: string | null = null;
    for (const message of thread.messages) {
      insertMessage.run(
        message.id,
        thread.id,
        parentId,
        message.role,
        message.text,
        message.createdAt,
      );
      parentId = message.id;
    }
  }
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

function ids(result: { items: { id: string }[] }): string[] {
  return result.items.map((item) => item.id);
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cleon-d2-"));
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

describe("schema", () => {
  it("applies migration 2 and exposes active_leaf_id", () => {
    expect(schemaVersion(conn)).toBe(2);

    const columns = conn.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain("active_leaf_id");

    // The column starts null on every thread written before D3: "follow the newest
    // leaf" is the behaviour those threads already had.
    const row = conn.prepare("SELECT active_leaf_id FROM threads WHERE id = ?").get(T.recent) as
      | { active_leaf_id: string | null }
      | undefined;
    expect(row?.active_leaf_id).toBeNull();
  });
});

describe("threads.list without a query", () => {
  it("orders pinned first then by recency, and hides archived and deleted threads", () => {
    const result = listThreads(db, { limit: 50, offset: 0, includeArchived: false });

    // Pinned wins over recency; the rest fall back to `updated_at DESC`.
    expect(ids(result)).toEqual([T.pinned, T.recent, T.older]);
    expect(result.total).toBe(3);

    const recent = result.items.find((item) => item.id === T.recent);
    expect(recent).toMatchObject({
      title: "Most recently edited",
      pinned: false,
      archivedAt: null,
      messageCount: 2,
      snippet: null,
    });
  });

  it("reports the total over the whole predicate, not the length of the page", () => {
    const firstPage = listThreads(db, { limit: 2, offset: 0, includeArchived: false });

    expect(firstPage.items).toHaveLength(2);
    // The page is clipped; the count is not. This is the difference between a
    // sidebar that can paginate and one that lies about how much is left.
    expect(firstPage.total).toBe(3);
  });

  it("includes archived threads only when asked, and never deleted ones", () => {
    const withArchived = listThreads(db, { limit: 50, offset: 0, includeArchived: true });

    expect(ids(withArchived)).toEqual([T.pinned, T.archived, T.recent, T.older]);
    expect(withArchived.total).toBe(4);
    expect(ids(withArchived)).not.toContain(T.deleted);

    const archived = withArchived.items.find((item) => item.id === T.archived);
    expect(archived?.archivedAt).toBe("2026-03-12T00:00:00.000Z");
  });

  it("walks pages without overlapping or skipping, and keeps the total stable", () => {
    const pages = [
      listThreads(db, { limit: 2, offset: 0, includeArchived: true }),
      listThreads(db, { limit: 2, offset: 2, includeArchived: true }),
      listThreads(db, { limit: 2, offset: 4, includeArchived: true }),
    ];

    expect(pages.map(ids)).toEqual([[T.pinned, T.archived], [T.recent, T.older], []]);
    expect(pages.map((page) => page.total)).toEqual([4, 4, 4]);

    const beyond = listThreads(db, { limit: 2, offset: 99, includeArchived: true });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(4);
  });

  it("satisfies the frozen threads.list contract", () => {
    const result = listThreads(db, { limit: 50, offset: 0, includeArchived: true });
    // The contract is the boundary, so the read has to be valid against it — uuid
    // shapes and ISO timestamps included — not merely plausible-looking.
    expect(() => contracts["threads.list"].response.parse(result)).not.toThrow();
  });
});

describe("threads.list with a query", () => {
  it("matches message text, ranks by relevance, and carries a snippet", () => {
    const result = listThreads(db, {
      query: "alpha",
      limit: 50,
      offset: 0,
      includeArchived: false,
    });

    // The deleted thread's matching message is not a result; the archived one is
    // excluded by the same default the plain list uses.
    expect(ids(result)).toEqual([T.recent]);
    expect(result.total).toBe(1);
    expect(result.items[0]?.snippet).toContain("[alpha]");
  });

  it("respects includeArchived while searching, and counts what it returns", () => {
    const result = listThreads(db, {
      query: "alpha",
      limit: 50,
      offset: 0,
      includeArchived: true,
    });

    expect(ids(result).sort()).toEqual([T.recent, T.archived].sort());
    expect(result.total).toBe(2);
  });

  it("requires every token to match, so a second word narrows the result", () => {
    const one = listThreads(db, { query: "alpha", limit: 50, offset: 0, includeArchived: true });
    const two = listThreads(db, {
      query: "alpha archived",
      limit: 50,
      offset: 0,
      includeArchived: true,
    });

    expect(two.items).toHaveLength(1);
    expect(two.total).toBe(1);
    expect(ids(two)).toEqual([T.archived]);
    expect(two.total).toBeLessThan(one.total);
  });

  it("returns nothing, rather than throwing, for a query with no searchable token", () => {
    // FTS5's MATCH argument is a parser: unquoted, each of these is a syntax error.
    // The search box is a text field, so they have to come back empty instead.
    for (const query of ["zzz-no-such-word", "!!!", '"', "alpha AND", "*", "-", "NEAR(", "OR"]) {
      const result = listThreads(db, { query, limit: 50, offset: 0, includeArchived: true });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    }
  });

  it("treats a quote inside a query as text, not as an unterminated phrase", () => {
    // `"alpha` is a quote followed by a word. Quoting each token means the stray
    // quote becomes part of the token rather than a phrase the parser rejects.
    for (const query of ['"alpha', 'alpha"', 'al"pha']) {
      const result = listThreads(db, { query, limit: 50, offset: 0, includeArchived: true });
      expect(result.total).toBe(query === 'al"pha' ? 0 : 2);
    }
  });

  it("treats a blank query as no query at all", () => {
    const blank = listThreads(db, { query: "   ", limit: 50, offset: 0, includeArchived: false });
    const none = listThreads(db, { limit: 50, offset: 0, includeArchived: false });

    expect(blank).toEqual(none);
    expect(blank.total).toBe(3);
  });

  it("paginates search results by relevance, with a stable total", () => {
    const first = listThreads(db, { query: "alpha", limit: 1, offset: 0, includeArchived: true });
    const second = listThreads(db, { query: "alpha", limit: 1, offset: 1, includeArchived: true });

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    expect([...ids(first), ...ids(second)].sort()).toEqual([T.recent, T.archived].sort());
    expect([first.total, second.total]).toEqual([2, 2]);
  });
});

describe("threads.update", () => {
  it("renames, pins, and archives, bumping updated_at each time", () => {
    const before = conn.prepare("SELECT updated_at FROM threads WHERE id = ?").get(T.older) as {
      updated_at: string;
    };

    updateThread(db, { threadId: T.older, title: "Renamed", pinned: true });

    const after = conn
      .prepare("SELECT title, pinned, archived_at, updated_at FROM threads WHERE id = ?")
      .get(T.older) as {
      title: string;
      pinned: number;
      archived_at: string | null;
      updated_at: string;
    };
    expect(after.title).toBe("Renamed");
    expect(after.pinned).toBe(1);
    expect(after.archived_at).toBeNull();
    // Not `>`: the machine clock is not part of this contract, only that the edit
    // moved the row's timestamp off the value the fixture wrote.
    expect(after.updated_at).not.toBe(before.updated_at);

    // A renamed, pinned thread now sorts among the pinned ones instead of last.
    const listed = listThreads(db, { limit: 50, offset: 0, includeArchived: false });
    expect(ids(listed)).toContain(T.older);
    expect(listed.items[0]?.pinned).toBe(true);
  });

  it("archives and unarchives, moving the thread in and out of the default list", () => {
    updateThread(db, { threadId: T.recent, archived: true });
    expect(ids(listThreads(db, { limit: 50, offset: 0, includeArchived: false }))).not.toContain(
      T.recent,
    );

    const archived = listThreads(db, { limit: 50, offset: 0, includeArchived: true });
    expect(archived.items.find((item) => item.id === T.recent)?.archivedAt).not.toBeNull();

    updateThread(db, { threadId: T.recent, archived: false });
    const restored = listThreads(db, { limit: 50, offset: 0, includeArchived: false });
    expect(ids(restored)).toContain(T.recent);
    expect(restored.items.find((item) => item.id === T.recent)?.archivedAt).toBeNull();
  });

  it("leaves fields it was not given alone", () => {
    updateThread(db, { threadId: T.recent, title: "Only the title" });

    const row = conn
      .prepare("SELECT title, pinned, archived_at FROM threads WHERE id = ?")
      .get(T.recent) as { title: string; pinned: number; archived_at: string | null };
    expect(row).toEqual({ title: "Only the title", pinned: 0, archived_at: null });
  });

  it("is NOT_FOUND for a thread that does not exist", () => {
    const missing: UpdateThreadInput = {
      threadId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      title: "nobody home",
    };
    expectAppError(() => updateThread(db, missing), "NOT_FOUND");
  });

  it("is NOT_FOUND for a soft-deleted thread: `.returning()` sees no row", () => {
    expectAppError(() => updateThread(db, { threadId: T.deleted, pinned: true }), "NOT_FOUND");

    const row = conn.prepare("SELECT pinned FROM threads WHERE id = ?").get(T.deleted) as {
      pinned: number;
    };
    expect(row.pinned).toBe(0);
  });
});

describe("threads.delete", () => {
  it("tombstones the thread instead of removing its history", () => {
    softDeleteThread(db, T.recent);

    const row = conn.prepare("SELECT deleted_at FROM threads WHERE id = ?").get(T.recent) as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).not.toBeNull();

    // The messages survive: `generations` cascades off `threads`, so a hard delete
    // would take the usage history with it.
    const messages = conn
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
      .get(T.recent) as { n: number };
    expect(messages.n).toBe(2);
  });

  it("removes the thread from every list, including the archived one", () => {
    softDeleteThread(db, T.recent);

    expect(ids(listThreads(db, { limit: 50, offset: 0, includeArchived: false }))).not.toContain(
      T.recent,
    );
    expect(ids(listThreads(db, { limit: 50, offset: 0, includeArchived: true }))).not.toContain(
      T.recent,
    );
    expect(
      listThreads(db, { query: "alpha", limit: 50, offset: 0, includeArchived: true }).items,
    ).not.toContainEqual(expect.objectContaining({ id: T.recent }));
  });

  it("is NOT_FOUND on the second delete, so a double tap cannot be mistaken for a second delete", () => {
    softDeleteThread(db, T.older);
    expectAppError(() => softDeleteThread(db, T.older), "NOT_FOUND");
  });

  it("is NOT_FOUND for a thread that never existed", () => {
    expectAppError(() => softDeleteThread(db, "ffffffff-ffff-4fff-8fff-ffffffffffff"), "NOT_FOUND");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase, schemaVersion } from "../../src/main/db/index.js";
import { MIGRATIONS } from "../../src/main/db/migrations.js";
import {
  createPrompt,
  deletePrompt,
  listPrompts,
  updatePrompt,
} from "../../src/main/db/repo-prompts.js";
import { AppError } from "../../src/main/errors.js";
import { contracts } from "../../src/shared/ipc-contract";

/**
 * D6 prompt library, searched **in SQL**.
 *
 * The claim under test is not "a search box filters a list": it is that `prompts.list`
 * matches in the database and therefore knows how many rows matched. Every search test
 * here checks `total` as well as the page, because a `total` equal to the page length is
 * the signature of a filter that ran in JavaScript on a single page — the exact bug the
 * brief forbids for a large library.
 *
 * LIKE's wildcards are part of the query language, so `%` and `_` are tested as data: a
 * user searching for "50%" means the characters, not "every prompt in the library".
 */

const P = {
  release: "11111111-1111-4111-8111-111111111111",
  review: "22222222-2222-4222-8222-222222222222",
  standup: "33333333-3333-4333-8333-333333333333",
} as const;

interface SeedPrompt {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

const SEED: SeedPrompt[] = [
  {
    id: P.release,
    title: "Release notes",
    body: "Summarise the changes in this release. Include a risk section.",
    updatedAt: "2026-03-03T00:00:00.000Z",
  },
  {
    id: P.review,
    title: "Code review",
    body: "Review this diff for security and 50% coverage gaps.",
    updatedAt: "2026-03-02T00:00:00.000Z",
  },
  {
    id: P.standup,
    title: "Standup",
    body: "Write a standup update from these commits.",
    updatedAt: "2026-03-01T00:00:00.000Z",
  },
];

let tempDir = "";
let conn: Db;
let db: DrizzleDb;

function reseed(): void {
  conn.exec("DELETE FROM prompts;");
  const insert = conn.prepare(
    "INSERT INTO prompts (id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const prompt of SEED) {
    insert.run(prompt.id, prompt.title, prompt.body, prompt.updatedAt, prompt.updatedAt);
  }
}

function search(query: string, limit = 50, offset = 0): { ids: string[]; total: number } {
  const result = listPrompts(db, { query, limit, offset });
  return { ids: result.items.map((item) => item.id), total: result.total };
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

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cleon-d6-prompts-"));
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

describe("the schema this slice relies on", () => {
  it("has migration 5 applied and a prompts table with the columns the repo uses", () => {
    // Derived from the ledger, so the assertion is "the newest migration is applied",
    // not a number that has to be edited by the next slice.
    expect(schemaVersion(conn)).toBe(MIGRATIONS.at(-1)?.version);

    const columns = conn.prepare("PRAGMA table_info(prompts)").all() as { name: string }[];
    expect(columns.map((column) => column.name).sort()).toEqual([
      "body",
      "created_at",
      "id",
      "title",
      "updated_at",
    ]);
  });
});

describe("prompts.list with no query", () => {
  it("returns the whole library, most recently edited first", () => {
    const result = listPrompts(db, { limit: 50, offset: 0 });

    expect(result.items.map((item) => item.id)).toEqual([P.release, P.review, P.standup]);
    expect(result.total).toBe(3);
    expect(result.items[0]).toMatchObject({
      title: "Release notes",
      body: "Summarise the changes in this release. Include a risk section.",
    });
  });

  it("treats a blank query as no query at all", () => {
    expect(search("   ")).toEqual(search(""));
    expect(search("   ").total).toBe(3);
  });

  it("satisfies the frozen prompts.list contract", () => {
    const result = listPrompts(db, { query: "release", limit: 50, offset: 0 });
    // The boundary is the type: uuid shapes and ISO timestamps included.
    expect(() => contracts["prompts.list"].response.parse(result)).not.toThrow();
  });
});

describe("prompts.list search", () => {
  it("matches the title, case-insensitively", () => {
    expect(search("RELEASE")).toEqual({ ids: [P.release], total: 1 });
    expect(search("standup")).toEqual({ ids: [P.standup], total: 1 });
  });

  it("matches the body when the title says nothing", () => {
    expect(search("commits")).toEqual({ ids: [P.standup], total: 1 });
  });

  it("requires every token, so a second word narrows rather than widens", () => {
    // Both words are in `review`; only one each in the others.
    expect(search("review security")).toEqual({ ids: [P.review], total: 1 });
    // One word from one prompt and one from another matches nothing. An OR would
    // return both, which is how a search box stops meaning what it says.
    expect(search("risk security")).toEqual({ ids: [], total: 0 });
  });

  it("counts every match, not just the page it returned", () => {
    // The proof that the search is SQL: "e" is in all three rows, the page is one row,
    // and the total is still three. A JS filter over a single page would report 1.
    const firstPage = search("e", 1, 0);
    const secondPage = search("e", 1, 1);

    expect(firstPage.ids).toHaveLength(1);
    expect(secondPage.ids).toHaveLength(1);
    expect(firstPage.ids[0]).not.toBe(secondPage.ids[0]);
    expect([firstPage.total, secondPage.total]).toEqual([3, 3]);
  });

  it("returns nothing, rather than throwing, for a term that matches no row", () => {
    expect(search("zzz-no-such-word")).toEqual({ ids: [], total: 0 });
    expect(search("'; DROP TABLE prompts; --")).toEqual({ ids: [], total: 0 });

    // Still there, and still the same rows: the query is bound, not concatenated.
    expect(listPrompts(db, { limit: 50, offset: 0 }).total).toBe(3);
  });

  it("treats LIKE wildcards as text, not as wildcards", () => {
    // "%" alone would match everything if it reached LIKE unescaped.
    expect(search("%")).toEqual({ ids: [P.review], total: 1 });
    // "50%" is the literal three characters the prompt contains.
    expect(search("50%")).toEqual({ ids: [P.review], total: 1 });
    // "_" is LIKE's single-character wildcard; escaped, it matches no row here.
    expect(search("_")).toEqual({ ids: [], total: 0 });
  });

  it("paginates with a stable total and no overlap", () => {
    const pages = [
      listPrompts(db, { limit: 2, offset: 0 }),
      listPrompts(db, { limit: 2, offset: 2 }),
      listPrompts(db, { limit: 2, offset: 4 }),
    ];

    expect(pages.map((page) => page.items.length)).toEqual([2, 1, 0]);
    expect(pages.map((page) => page.total)).toEqual([3, 3, 3]);
    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual([
      P.release,
      P.review,
      P.standup,
    ]);
  });
});

describe("prompts CRUD", () => {
  it("creates a prompt and reads it back from the database", () => {
    const created = createPrompt(db, { title: "Retro", body: "Write a retro from these notes." });

    expect(created).toMatchObject({ title: "Retro", body: "Write a retro from these notes." });
    expect(created.createdAt).toBe(created.updatedAt);

    const found = listPrompts(db, { query: "retro", limit: 50, offset: 0 });
    expect(found.items.map((item) => item.id)).toEqual([created.id]);
  });

  it("updates only what it was given and returns the stored row", () => {
    const created = createPrompt(db, { title: "Draft", body: "First version." });
    conn
      .prepare("UPDATE prompts SET updated_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", created.id);

    const renamed = updatePrompt(db, { promptId: created.id, title: "Final" });

    expect(renamed).toMatchObject({ title: "Final", body: "First version." });
    expect(renamed.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");

    // A body-only edit leaves the title alone, and the new body is searchable.
    updatePrompt(db, { promptId: created.id, body: "Second version, with a rubric." });
    expect(search("rubric").ids).toEqual([created.id]);
    expect(updatePrompt(db, { promptId: created.id }).title).toBe("Final");
  });

  it("deletes for real: it is text, and there is nothing to cascade", () => {
    deletePrompt(db, P.standup);

    const remaining = listPrompts(db, { limit: 50, offset: 0 });
    expect(remaining.items.map((item) => item.id)).toEqual([P.release, P.review]);
    expect(remaining.total).toBe(2);

    const row = conn.prepare("SELECT COUNT(*) AS n FROM prompts WHERE id = ?").get(P.standup) as {
      n: number;
    };
    expect(row.n).toBe(0);
  });

  it("is NOT_FOUND on a second delete and on an update of a missing row", () => {
    deletePrompt(db, P.standup);
    expectAppError(() => deletePrompt(db, P.standup), "NOT_FOUND");
    expectAppError(() => updatePrompt(db, { promptId: P.standup, title: "x" }), "NOT_FOUND");
    expectAppError(() => deletePrompt(db, "ffffffff-ffff-4fff-8fff-ffffffffffff"), "NOT_FOUND");
  });
});

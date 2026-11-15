import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";
import {
  createThread,
  insertMessage,
  listThreads,
  softDeleteThread,
} from "../../src/main/db/repo.js";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
} from "../../src/main/db/repo-projects.js";
import { AppError } from "../../src/main/errors.js";

/**
 * D6 projects: the folders the sidebar files threads under.
 *
 * Two things are asserted that no amount of UI would catch:
 *
 *  - **The thread count is a database aggregate over live rows.** A soft-deleted thread
 *    must not be counted, and a project with no threads must read `0` rather than
 *    missing from the list.
 *  - **The project filter is in the SQL, on both branches of `threads.list`.** The plain
 *    branch and the FTS branch are different queries, and the filter has to be in both —
 *    the search path is the one a reviewer forgets.
 */

const PROJECTS = {
  platform: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  writing: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const THREADS = {
  inPlatform: "11111111-1111-4111-8111-111111111111",
  inPlatformDeleted: "22222222-2222-4222-8222-222222222222",
  inWriting: "33333333-3333-4333-8333-333333333333",
  unfiled: "44444444-4444-4444-8444-444444444444",
} as const;

let tempDir = "";
let conn: Db;
let db: DrizzleDb;

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
  tempDir = await mkdtemp(join(tmpdir(), "cleon-d6-projects-"));
  conn = openDatabase(join(tempDir, "cleon.db"));
  db = createDb(conn);
});

afterAll(async () => {
  closeDatabase();
  if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Messages first: their delete trigger clears the FTS index. Deleting the threads and
  // letting the cascade run would leave FTS rows behind, because the cascade only fires
  // delete triggers with `recursive_triggers` on, which this app does not enable.
  conn.exec("DELETE FROM generations; DELETE FROM messages; DELETE FROM threads;");
  conn.exec("DELETE FROM projects; DELETE FROM assistants;");

  conn
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(PROJECTS.platform, "Platform", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  conn
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(PROJECTS.writing, "Writing", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");

  createThread(db, { id: THREADS.inPlatform, projectId: PROJECTS.platform });
  createThread(db, { id: THREADS.inPlatformDeleted, projectId: PROJECTS.platform });
  createThread(db, { id: THREADS.inWriting, projectId: PROJECTS.writing });
  createThread(db, { id: THREADS.unfiled });

  insertMessage(db, {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    threadId: THREADS.inPlatform,
    parentId: null,
    role: "user",
    text: "deploy the scheduler",
  });
  insertMessage(db, {
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    threadId: THREADS.inWriting,
    parentId: null,
    role: "user",
    text: "deploy the newsletter",
  });
  insertMessage(db, {
    id: "cccccccc-0000-4000-8000-000000000001",
    threadId: THREADS.unfiled,
    parentId: null,
    role: "user",
    text: "deploy something unfiled",
  });

  softDeleteThread(db, THREADS.inPlatformDeleted);
});

describe("projects CRUD", () => {
  it("creates a project and lists it with a count of zero", () => {
    const created = createProject(db, "  Research  ");

    // Trimmed by the repository, because a name is what the sidebar shows.
    expect(created).toMatchObject({ name: "Research", archivedAt: null });
    expect(created.createdAt).toBe(created.updatedAt);
    expect(getProject(db, created.id)?.name).toBe("Research");

    const listed = listProjects(db);
    expect(listed.items.map((item) => [item.name, item.threadCount])).toEqual([
      ["Platform", 1],
      ["Research", 0],
      ["Writing", 1],
    ]);
    expect(listed.total).toBe(3);
  });

  it("renames a project without touching its threads", () => {
    updateProject(db, { projectId: PROJECTS.writing, name: "Docs" });

    expect(getProject(db, PROJECTS.writing)?.name).toBe("Docs");
    // The threads file under the id, not the name.
    expect(
      listThreads(db, { limit: 50, offset: 0, includeArchived: false, projectId: PROJECTS.writing })
        .items,
    ).toHaveLength(1);
  });

  it("archives a project: it leaves the list but its threads keep pointing at it", () => {
    updateProject(db, { projectId: PROJECTS.writing, archived: true });

    expect(listProjects(db).items.map((item) => item.name)).toEqual(["Platform"]);
    expect(getProject(db, PROJECTS.writing)?.archivedAt).not.toBeNull();

    // Unarchiving puts it back, with its count intact.
    updateProject(db, { projectId: PROJECTS.writing, archived: false });
    expect(listProjects(db).items.map((item) => item.name)).toEqual(["Platform", "Writing"]);
  });

  it("is NOT_FOUND for a project that does not exist", () => {
    expectAppError(
      () => updateProject(db, { projectId: "ffffffff-ffff-4fff-8fff-ffffffffffff", name: "x" }),
      "NOT_FOUND",
    );
  });

  it("refuses a blank name rather than storing one", () => {
    expectAppError(() => createProject(db, "   "), "BAD_REQUEST");
    expectAppError(
      () => updateProject(db, { projectId: PROJECTS.platform, name: "" }),
      "BAD_REQUEST",
    );
  });
});

describe("the project thread count", () => {
  it("counts live threads only", () => {
    const platform = listProjects(db).items.find((item) => item.id === PROJECTS.platform);
    // Two threads were filed under it; one was deleted.
    expect(platform?.threadCount).toBe(1);
  });

  it("moves when a thread is created and when it is deleted", () => {
    const before = listProjects(db).items.find(
      (item) => item.id === PROJECTS.platform,
    )?.threadCount;
    expect(before).toBe(1);

    createThread(db, { id: "55555555-5555-4555-8555-555555555555", projectId: PROJECTS.platform });
    expect(listProjects(db).items.find((item) => item.id === PROJECTS.platform)?.threadCount).toBe(
      2,
    );

    softDeleteThread(db, "55555555-5555-4555-8555-555555555555");
    expect(listProjects(db).items.find((item) => item.id === PROJECTS.platform)?.threadCount).toBe(
      1,
    );
  });
});

describe("threads.list filtered by project", () => {
  it("returns only that project's threads, with the total over the filter", () => {
    const platform = listThreads(db, {
      limit: 50,
      offset: 0,
      includeArchived: false,
      projectId: PROJECTS.platform,
    });

    expect(platform.items.map((item) => item.id)).toEqual([THREADS.inPlatform]);
    expect(platform.total).toBe(1);
    expect(platform.items[0]?.projectId).toBe(PROJECTS.platform);

    const unfiled = listThreads(db, { limit: 50, offset: 0, includeArchived: false });
    expect(unfiled.total).toBe(3);
    // An unfiled thread reports null, not a missing field: the contract says so.
    expect(unfiled.items.find((item) => item.id === THREADS.unfiled)?.projectId).toBeNull();
  });

  it("applies the filter to the search branch too", () => {
    // All three live threads match "deploy"; only one of them is in the Platform project.
    const all = listThreads(db, {
      query: "deploy",
      limit: 50,
      offset: 0,
      includeArchived: false,
    });
    expect(all.total).toBe(3);

    const filtered = listThreads(db, {
      query: "deploy",
      limit: 50,
      offset: 0,
      includeArchived: false,
      projectId: PROJECTS.platform,
    });
    expect(filtered.items.map((item) => item.id)).toEqual([THREADS.inPlatform]);
    // The count and the page agree, which is the whole point of filtering in SQL.
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.snippet).toContain("[deploy]");
  });

  it("keeps the archived scope independent of the project filter", () => {
    updateProject(db, { projectId: PROJECTS.platform, archived: true });

    // Archiving a project does not archive its threads: the filter still finds them, and
    // "All threads" still lists them.
    expect(
      listThreads(db, {
        limit: 50,
        offset: 0,
        includeArchived: false,
        projectId: PROJECTS.platform,
      }).total,
    ).toBe(1);
    expect(listThreads(db, { limit: 50, offset: 0, includeArchived: false }).total).toBe(3);
  });
});

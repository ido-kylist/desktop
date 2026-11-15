import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";
import { createThread } from "../../src/main/db/repo.js";
import {
  bumpCurrentVersion,
  getArtifact,
  getArtifactHistory,
  getArtifactVersion,
  listArtifacts,
  saveArtifact,
} from "../../src/main/db/repo-artifacts.js";
import { AppError } from "../../src/main/errors.js";
import { contracts } from "../../src/shared/ipc-contract";

/**
 * Versioned artifacts against a real SQLite file.
 *
 * The claim under test is that **a save appends**. Nothing here mocks the database, because
 * every interesting property is a database property: the `UNIQUE (artifact_id, version)`
 * index, the conditional bump of `current_version`, the cascade from a thread, and the fact
 * that version 1's text is byte-identical after version 2 is written.
 *
 * The handler record lives in `src/main/index.ts`, which imports Electron and cannot be
 * imported here; what is exercised is the same chain the handler runs.
 */

let tempDir = "";
let conn: Db;
let db: DrizzleDb;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cleon-d8-art-"));
  conn = openDatabase(join(tempDir, "cleon.db"));
  db = createDb(conn);
});

afterAll(async () => {
  closeDatabase();
  if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Artifacts cascade off threads, so removing the threads removes everything.
  conn.exec("DELETE FROM threads;");
});

/** A thread to file artifacts under. Throws are soft-deleted, so a real row is required. */
function seedThread(): string {
  const threadId = randomUUID();
  createThread(db, { id: threadId });
  return threadId;
}

function expectAppError(run: () => unknown, code: string): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

describe("saving", () => {
  it("creates version 1, with the row the response describes", () => {
    const threadId = seedThread();

    const { artifact, version } = saveArtifact(db, {
      artifactId: null,
      threadId,
      title: "Runbook",
      content: "first draft",
    });

    expect(artifact).toMatchObject({ threadId, title: "Runbook", currentVersion: 1 });
    expect(version).toMatchObject({ artifactId: artifact.id, version: 1, content: "first draft" });

    // The boundary shape, parsed rather than eyeballed.
    expect(() => contracts["artifacts.save"].response.parse({ artifact, version })).not.toThrow();
  });

  it("appends version 2 on the next save, and returns the number it wrote", () => {
    const threadId = seedThread();
    const created = saveArtifact(db, {
      artifactId: null,
      threadId,
      title: "Runbook",
      content: "first draft",
    });

    const second = saveArtifact(db, {
      artifactId: created.artifact.id,
      threadId,
      title: "Runbook",
      content: "second draft",
    });

    expect(second.artifact.currentVersion).toBe(2);
    expect(second.version).toMatchObject({ version: 2, content: "second draft" });
    // Same artifact: an edit is not a new document.
    expect(second.artifact.id).toBe(created.artifact.id);
  });

  it("renames with the save, because the title is part of what was edited", () => {
    const threadId = seedThread();
    const created = saveArtifact(db, {
      artifactId: null,
      threadId,
      title: "Runbook",
      content: "one",
    });

    const renamed = saveArtifact(db, {
      artifactId: created.artifact.id,
      threadId,
      title: "Runbook (v2)",
      content: "two",
    });

    expect(renamed.artifact.title).toBe("Runbook (v2)");
    expect(getArtifact(db, created.artifact.id)?.title).toBe("Runbook (v2)");
  });

  it("keeps the versions contiguous, with no gaps", () => {
    const threadId = seedThread();
    const created = saveArtifact(db, { artifactId: null, threadId, title: "Notes", content: "v1" });

    let artifactId = created.artifact.id;
    for (let index = 2; index <= 5; index += 1) {
      const saved = saveArtifact(db, {
        artifactId,
        threadId,
        title: "Notes",
        content: `v${index}`,
      });
      artifactId = saved.artifact.id;
    }

    const history = getArtifactHistory(db, artifactId);
    expect(history).not.toBeNull();
    if (history === null) return;

    expect(history.versions.map((version) => version.version)).toEqual([1, 2, 3, 4, 5]);
    expect(history.artifact.currentVersion).toBe(5);
    expect(history.latest.version).toBe(5);
    expect(history.latest.content).toBe("v5");
  });

  it("is NOT_FOUND for an artifact id that does not exist", () => {
    const threadId = seedThread();
    const artifactId = randomUUID();

    const error = expectAppError(
      () => saveArtifact(db, { artifactId, threadId, title: "Ghost", content: "nothing" }),
      "NOT_FOUND",
    );
    expect(error.details).toMatchObject({ artifactId });
  });

  it("is NOT_FOUND when the artifact belongs to another thread", () => {
    // The thread is part of the address: an id from another conversation must not be
    // writable by guessing it, and NOT_FOUND rather than CONFLICT keeps the answer from
    // confirming that the id exists somewhere.
    const mine = seedThread();
    const theirs = seedThread();
    const created = saveArtifact(db, {
      artifactId: null,
      threadId: theirs,
      title: "Theirs",
      content: "x",
    });

    const error = expectAppError(
      () =>
        saveArtifact(db, {
          artifactId: created.artifact.id,
          threadId: mine,
          title: "Mine now",
          content: "hijacked",
        }),
      "NOT_FOUND",
    );
    expect(error.details).toMatchObject({ artifactId: created.artifact.id, threadId: mine });

    // And the row is untouched.
    const history = getArtifactHistory(db, created.artifact.id);
    expect(history?.artifact.title).toBe("Theirs");
    expect(history?.versions).toHaveLength(1);
  });

  it("is NOT_FOUND when the thread does not exist at all", () => {
    expectAppError(
      () =>
        saveArtifact(db, {
          artifactId: null,
          threadId: randomUUID(),
          title: "Orphan",
          content: "x",
        }),
      "NOT_FOUND",
    );

    expect(listArtifacts(db, randomUUID()).total).toBe(0);
  });
});

describe("reading", () => {
  it("returns every version and names the latest", () => {
    const threadId = seedThread();
    const created = saveArtifact(db, {
      artifactId: null,
      threadId,
      title: "Spec",
      content: "outline",
    });
    saveArtifact(db, {
      artifactId: created.artifact.id,
      threadId,
      title: "Spec",
      content: "outline + detail",
    });

    const history = getArtifactHistory(db, created.artifact.id);
    expect(history).not.toBeNull();
    if (history === null) return;

    expect(history.versions).toHaveLength(2);
    expect(history.latest).toEqual(history.versions[1]);
    expect(() =>
      contracts["artifacts.get"].response.parse({
        artifact: history.artifact,
        versions: history.versions,
        latest: history.latest,
      }),
    ).not.toThrow();
  });

  it("is null for an id that does not exist, so the handler can say NOT_FOUND", () => {
    expect(getArtifactHistory(db, randomUUID())).toBeNull();
    expect(getArtifact(db, randomUUID())).toBeNull();
  });

  it("lists a thread's artifacts newest first, and only that thread's", () => {
    const mine = seedThread();
    const theirs = seedThread();

    const first = saveArtifact(db, { artifactId: null, threadId: mine, title: "One", content: "" });
    const second = saveArtifact(db, {
      artifactId: null,
      threadId: mine,
      title: "Two",
      content: "",
    });
    saveArtifact(db, { artifactId: null, threadId: theirs, title: "Theirs", content: "" });

    const listed = listArtifacts(db, mine);

    expect(listed.total).toBe(2);
    expect(listed.items.map((artifact) => artifact.title).sort()).toEqual(["One", "Two"]);
    // Newest first: the list is by creation order descending.
    expect(listed.items[0]?.id).toBe(second.artifact.id);
    expect(listed.items[1]?.id).toBe(first.artifact.id);
    // The row says which version is current, so the list can label it without reading them.
    expect(listed.items.every((artifact) => artifact.currentVersion === 1)).toBe(true);
  });

  it("counts an empty thread as zero rather than as a missing thread", () => {
    const threadId = seedThread();
    expect(listArtifacts(db, threadId)).toEqual({ items: [], total: 0 });
  });
});

describe("immutability", () => {
  it("leaves version 1 exactly as it was after version 2 is written", () => {
    const threadId = seedThread();
    const created = saveArtifact(db, {
      artifactId: null,
      threadId,
      title: "Log",
      content: "the original text",
    });

    saveArtifact(db, {
      artifactId: created.artifact.id,
      threadId,
      title: "Log",
      content: "rewritten text",
    });

    const original = getArtifactVersion(db, created.artifact.id, 1);
    expect(original?.content).toBe("the original text");
    // The same row, not a replacement: an edit inserts, it never rewrites.
    expect(original?.id).toBe(created.version.id);
  });

  it("refuses a second row with the same version number", () => {
    const threadId = seedThread();
    const created = saveArtifact(db, {
      artifactId: null,
      threadId,
      title: "Log",
      content: "one",
    });

    expect(() =>
      conn
        .prepare(
          "INSERT INTO artifact_versions (id, artifact_id, version, content) VALUES (?, ?, ?, ?)",
        )
        .run(randomUUID(), created.artifact.id, 1, "duplicate"),
    ).toThrow();
  });

  it("is CONFLICT when the version moved under the save, rather than overwriting it", () => {
    // The guard, called directly with the version a caller read *before* another save landed.
    // The conditional UPDATE matches no row, so the stale write is refused instead of
    // appending a second row with the same version number.
    const threadId = seedThread();
    const created = saveArtifact(db, {
      artifactId: null,
      threadId,
      title: "Log",
      content: "one",
    });
    saveArtifact(db, {
      artifactId: created.artifact.id,
      threadId,
      title: "Log",
      content: "two",
    });

    const error = expectAppError(
      () =>
        bumpCurrentVersion(db, {
          artifactId: created.artifact.id,
          threadId,
          expected: 1,
          title: "Log",
        }),
      "CONFLICT",
    );
    expect(error.details).toMatchObject({ reason: "version_race", expected: 1 });

    // The stored state is whatever the winning save wrote: two versions, current 2.
    const history = getArtifactHistory(db, created.artifact.id);
    expect(history?.artifact.currentVersion).toBe(2);
    expect(history?.versions).toHaveLength(2);

    // And the same call with the real current version goes through, at 3.
    expect(
      bumpCurrentVersion(db, {
        artifactId: created.artifact.id,
        threadId,
        expected: 2,
        title: "Log",
      }),
    ).toBe(3);
  });

  it("is NOT_FOUND from the bump when the artifact is not in that thread", () => {
    const mine = seedThread();
    const theirs = seedThread();
    const created = saveArtifact(db, {
      artifactId: null,
      threadId: theirs,
      title: "Theirs",
      content: "x",
    });

    expectAppError(
      () =>
        bumpCurrentVersion(db, {
          artifactId: created.artifact.id,
          threadId: mine,
          expected: 1,
          title: "Theirs",
        }),
      "NOT_FOUND",
    );
  });
});

describe("lifecycle with its thread", () => {
  it("removes its artifacts when the thread row is really deleted", () => {
    const threadId = seedThread();
    saveArtifact(db, { artifactId: null, threadId, title: "One", content: "x" });
    saveArtifact(db, { artifactId: null, threadId, title: "Two", content: "y" });

    expect(listArtifacts(db, threadId).total).toBe(2);

    conn.prepare("DELETE FROM threads WHERE id = ?").run(threadId);

    expect(listArtifacts(db, threadId).total).toBe(0);
    const versions = conn.prepare("SELECT count(*) AS n FROM artifact_versions").get() as {
      n: number;
    };
    expect(versions.n).toBe(0);
  });

  it("is BAD_REQUEST for a blank title at the boundary, before any write", () => {
    // The contract trims and requires a title; this is the schema's own guard, asserted here
    // because a row with an empty title is a row the list cannot render.
    const threadId = seedThread();

    expect(() =>
      contracts["artifacts.save"].request.parse({
        artifactId: null,
        threadId,
        title: "  ",
        content: "",
      }),
    ).toThrow();
  });
});

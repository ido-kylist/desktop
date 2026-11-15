import { randomUUID } from "node:crypto";
import type { Artifact, ArtifactVersion } from "@shared/ipc-contract";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { AppError } from "../errors.js";
import type { DrizzleDb } from "./client.js";
import { artifacts, artifactVersions, threads } from "./schema.js";

/**
 * Versioned artifacts: a named document a thread owns, edited by appending.
 *
 * The invariant this module exists to keep is that **a version row is never changed**. Save
 * writes n+1; the older rows are read-only forever. That is what makes "show me v2" a
 * question with an answer, and it is why there is no `updateVersion` anywhere below.
 *
 * The bump is a conditional `UPDATE … WHERE current_version = ?` with `.returning()`, not a
 * read followed by a write. Under this app's single-process SQLite the difference is
 * theoretical, but the read-then-write version has a second writer's failure mode (two
 * saves landing on version 3 and one of them losing) and the conditional one does not: the
 * loser matches no row and gets a CONFLICT it can retry.
 */

const ARTIFACT_COLUMNS = {
  id: artifacts.id,
  threadId: artifacts.threadId,
  title: artifacts.title,
  currentVersion: artifacts.currentVersion,
  createdAt: artifacts.createdAt,
} as const;

const VERSION_COLUMNS = {
  id: artifactVersions.id,
  artifactId: artifactVersions.artifactId,
  version: artifactVersions.version,
  content: artifactVersions.content,
  createdAt: artifactVersions.createdAt,
} as const;

/**
 * Writes version 1 of a new artifact, or version n+1 of an existing one.
 *
 * `artifactId: null` is creation. The thread has to exist: an artifact belongs to a
 * conversation, and a row filed under a thread that is not there would be unreachable —
 * the list read is by thread, so nothing could ever show it.
 *
 * A thread that is soft-deleted still accepts a save. The rows are the user's, the thread is
 * only hidden from the sidebar, and refusing an edit because a conversation was archived
 * would throw away work the user can still reach through the artifact panel.
 */
export function saveArtifact(
  db: DrizzleDb,
  input: { artifactId: string | null; threadId: string; title: string; content: string },
): { artifact: Artifact; version: ArtifactVersion } {
  assertThreadExists(db, input.threadId);

  if (input.artifactId === null) return createArtifact(db, input);
  return appendVersion(db, input.artifactId, input.threadId, input.title, input.content);
}

function createArtifact(
  db: DrizzleDb,
  input: { threadId: string; title: string; content: string },
): { artifact: Artifact; version: ArtifactVersion } {
  const artifactId = randomUUID();
  const versionId = randomUUID();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.insert(artifacts)
      .values({
        id: artifactId,
        threadId: input.threadId,
        title: input.title,
        currentVersion: 1,
        createdAt: now,
      })
      .run();

    tx.insert(artifactVersions)
      .values({
        id: versionId,
        artifactId,
        version: 1,
        content: input.content,
        createdAt: now,
      })
      .run();
  });

  const artifact = getArtifact(db, artifactId);
  if (artifact === null) {
    throw new AppError("INTERNAL", "the artifact was not written", { details: { artifactId } });
  }
  return {
    artifact,
    version: { id: versionId, artifactId, version: 1, content: input.content, createdAt: now },
  };
}

/**
 * Appends the next version.
 *
 * The conditional bump is the whole concurrency story: `WHERE current_version = ?` matches
 * only if nobody appended since the read, and the version number written is the one the
 * update *returned* rather than the one that was read. A retry after a CONFLICT is a new save
 * with the same content, which is what the user asked for anyway.
 */
function appendVersion(
  db: DrizzleDb,
  artifactId: string,
  threadId: string,
  title: string,
  content: string,
): { artifact: Artifact; version: ArtifactVersion } {
  const versionId = randomUUID();
  const now = new Date().toISOString();

  const next = db.transaction((tx) => {
    const current = tx
      .select({ currentVersion: artifacts.currentVersion })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .get();

    if (current === undefined) {
      throw new AppError("NOT_FOUND", "artifact not found", { details: { artifactId } });
    }

    const version = bumpCurrentVersion(tx, {
      artifactId,
      threadId,
      expected: current.currentVersion,
      // A rename travels with the save: the title is part of what the user edited, and
      // keeping the old one would make the list disagree with the document they opened.
      title,
    });

    tx.insert(artifactVersions)
      .values({ id: versionId, artifactId, version, content, createdAt: now })
      .run();

    return version;
  });

  const artifact = getArtifact(db, artifactId);
  if (artifact === null) {
    throw new AppError("INTERNAL", "the artifact disappeared during the write", {
      details: { artifactId },
    });
  }
  return {
    artifact,
    version: { id: versionId, artifactId, version: next, content, createdAt: now },
  };
}

/**
 * Moves `current_version` from `expected` to `expected + 1`, and answers with the new number.
 *
 * One statement, with every guard in its own `WHERE`: the artifact must be in this thread and
 * still be at the version the caller read. A preceding SELECT followed by an unconditional
 * UPDATE would let a second writer's version be silently overwritten — the classic lost
 * update — and this cannot.
 *
 * When nothing matched, a second read says *which* guard failed. The distinction matters to
 * the caller: NOT_FOUND means the address is wrong, CONFLICT means the value moved and a
 * retry is reasonable.
 */
export function bumpCurrentVersion(
  db: DrizzleDb,
  input: { artifactId: string; threadId: string; expected: number; title: string },
): number {
  const bumped = db
    .update(artifacts)
    .set({
      currentVersion: sql`${artifacts.currentVersion} + 1`,
      title: input.title,
    })
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.threadId, input.threadId),
        eq(artifacts.currentVersion, input.expected),
      ),
    )
    .returning({ currentVersion: artifacts.currentVersion })
    .all();

  const next = bumped[0]?.currentVersion;
  if (next !== undefined) return next;

  const exists = db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.threadId, input.threadId)))
    .get();

  if (exists === undefined) {
    throw new AppError("NOT_FOUND", "artifact not found in thread", {
      details: { artifactId: input.artifactId, threadId: input.threadId },
    });
  }

  throw new AppError("CONFLICT", "the artifact changed while it was being saved", {
    details: {
      reason: "version_race",
      artifactId: input.artifactId,
      expected: input.expected,
    },
  });
}

export function getArtifact(db: DrizzleDb, artifactId: string): Artifact | null {
  const row = db.select(ARTIFACT_COLUMNS).from(artifacts).where(eq(artifacts.id, artifactId)).get();
  return row ?? null;
}

/**
 * An artifact and every version it has, oldest first.
 *
 * The whole history in one read: an artifact has tens of versions, not thousands, and a
 * version switcher that had to page would be a switcher nobody uses. `latest` is picked out
 * of the same list rather than fetched with a second query, so the two can never disagree.
 */
export function getArtifactHistory(
  db: DrizzleDb,
  artifactId: string,
): { artifact: Artifact; versions: ArtifactVersion[]; latest: ArtifactVersion } | null {
  const artifact = getArtifact(db, artifactId);
  if (artifact === null) return null;

  const versions = db
    .select(VERSION_COLUMNS)
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(asc(artifactVersions.version))
    .all();

  const latest =
    versions.find((version) => version.version === artifact.currentVersion) ?? versions.at(-1);
  if (latest === undefined) {
    // A row with no version at all is a broken write, not an empty artifact: creation writes
    // both in one transaction, and every save appends one.
    throw new AppError("INTERNAL", "artifact has no versions", { details: { artifactId } });
  }

  return { artifact, versions, latest };
}

/** A thread's artifacts, newest first. No versions: the row says which one is current. */
export function listArtifacts(
  db: DrizzleDb,
  threadId: string,
): { items: Artifact[]; total: number } {
  const items = db
    .select(ARTIFACT_COLUMNS)
    .from(artifacts)
    .where(eq(artifacts.threadId, threadId))
    // `rowid` as the tiebreaker, descending like the timestamp: two artifacts created in the
    // same millisecond are the normal case here (a test creates them back to back, and so
    // does a user with a script), and ordering them by a random uuid would make the list
    // reorder itself between two reads.
    .orderBy(desc(artifacts.createdAt), desc(sql`"artifacts"."rowid"`))
    .all();

  const counted = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(artifacts)
    .where(eq(artifacts.threadId, threadId))
    .get();

  return { items, total: counted?.n ?? 0 };
}

/** One version by number, for a test that asserts immutability rather than the latest. */
export function getArtifactVersion(
  db: DrizzleDb,
  artifactId: string,
  version: number,
): ArtifactVersion | null {
  const row = db
    .select(VERSION_COLUMNS)
    .from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.version, version)))
    .get();
  return row ?? null;
}

/**
 * A thread that the database knows about, or NOT_FOUND.
 *
 * Soft-deleted threads still count: see `saveArtifact` for why an archived conversation does
 * not take its artifacts away.
 */
function assertThreadExists(db: DrizzleDb, threadId: string): void {
  const row = db.select({ id: threads.id }).from(threads).where(eq(threads.id, threadId)).get();
  if (row === undefined) {
    throw new AppError("NOT_FOUND", "thread not found", { details: { threadId } });
  }
}

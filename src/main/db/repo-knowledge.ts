import { randomUUID } from "node:crypto";
import type { Citation } from "@shared/ipc-contract";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "../errors.js";
import type { DrizzleDb } from "./client.js";
import { chunks, documents } from "./schema.js";

/**
 * The knowledge base's SQL: two tables, and nothing above them.
 *
 * The rule the rest of this slice rests on is here: a document row and its chunks are
 * written in one transaction. A document whose chunks are half-written would report a
 * `chunk_count` it does not have, and retrieval would quietly answer from a fragment of the
 * file the user thinks it read.
 *
 * Vectors cross this boundary already encoded. The database's business is bytes and a
 * width, not the numeric type a vector happens to be — that conversion belongs to the one
 * module that also reads them back (`knowledge/cosine.ts`).
 */

/** One document, in the contract's shape, so the handler is a pass-through. */
export interface DocumentRow {
  id: string;
  title: string;
  sourcePath: string;
  mime: string;
  bytes: number;
  chunkCount: number;
  createdAt: string;
}

const DOCUMENT_COLUMNS = {
  id: documents.id,
  title: documents.title,
  sourcePath: documents.sourcePath,
  mime: documents.mime,
  bytes: documents.bytes,
  chunkCount: documents.chunkCount,
  createdAt: documents.createdAt,
} as const;

/** One chunk to write: its text, its vector's bytes, and the vector's width. */
export interface NewChunk {
  text: string;
  embedding: Buffer;
  dim: number;
}

export interface InsertDocumentInput {
  id: string;
  title: string;
  sourcePath: string;
  mime: string;
  bytes: number;
  chunks: readonly NewChunk[];
}

/**
 * Writes a document and its chunks, or neither.
 *
 * The uniqueness of `source_path` is enforced by the index, not by a preceding SELECT: two
 * concurrent ingests of the same file would both pass a SELECT and both insert, and the
 * second would be a duplicate nobody asked for. The constraint failure is translated here
 * so the caller gets a sentence instead of a driver error string.
 *
 * Chunk ids are generated here rather than by the caller: they are row identity, and the
 * caller's only business with a chunk is its text and its vector.
 */
export function insertDocument(db: DrizzleDb, input: InsertDocumentInput): DocumentRow {
  const now = new Date().toISOString();

  try {
    db.transaction((tx) => {
      tx.insert(documents)
        .values({
          id: input.id,
          title: input.title,
          sourcePath: input.sourcePath,
          mime: input.mime,
          bytes: input.bytes,
          chunkCount: input.chunks.length,
          createdAt: now,
        })
        .run();

      input.chunks.forEach((chunk, ordinal) => {
        tx.insert(chunks)
          .values({
            id: randomUUID(),
            documentId: input.id,
            ordinal,
            text: chunk.text,
            embedding: chunk.embedding,
            dim: chunk.dim,
            createdAt: now,
          })
          .run();
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("CONFLICT", "that file is already indexed", {
        details: { reason: "already_indexed", sourcePath: input.sourcePath },
      });
    }
    throw error;
  }

  const row = getDocument(db, input.id);
  if (row === null) {
    throw new AppError("INTERNAL", "the document was not written", { details: { id: input.id } });
  }
  return row;
}

export function getDocument(db: DrizzleDb, documentId: string): DocumentRow | null {
  const row = db.select(DOCUMENT_COLUMNS).from(documents).where(eq(documents.id, documentId)).get();
  return row ?? null;
}

/** Newest first: the file just added is the one a user is looking for. */
export function listDocuments(db: DrizzleDb): { items: DocumentRow[]; total: number } {
  const items = db
    .select(DOCUMENT_COLUMNS)
    .from(documents)
    // `rowid` descending as the tiebreaker: two files added in the same millisecond are a
    // normal batch, and ordering them by a random uuid would shuffle the list between reads.
    .orderBy(desc(documents.createdAt), desc(sql`"documents"."rowid"`))
    .all();

  const counted = db.select({ n: sql<number>`COUNT(*)` }).from(documents).get();
  return { items, total: counted?.n ?? 0 };
}

/**
 * Removes the document and, by the foreign key's cascade, every chunk under it.
 *
 * A second delete is NOT_FOUND rather than a silent success: the panel asked to delete
 * something the database no longer has, and an `{ ok: true }` for that would be a lie the
 * next `kb.listDocuments` contradicts.
 */
export function deleteDocument(db: DrizzleDb, documentId: string): void {
  const deleted = db
    .delete(documents)
    .where(eq(documents.id, documentId))
    .returning({ id: documents.id })
    .all();

  if (deleted.length === 0) {
    throw new AppError("NOT_FOUND", "document not found", { details: { documentId } });
  }
}

/** One stored vector and the metadata a result row needs. */
export interface StoredChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  text: string;
  dim: number;
  embedding: Buffer;
}

/**
 * Every chunk whose vector is the same width as the query's.
 *
 * The `dim` filter is the incomparability filter: a document indexed with a 64-dimension
 * mock and a query embedded with a 1536-dimension model are not on the same scale, and
 * cosine over a prefix of one is a number with no meaning. Rows of another width are
 * skipped here, and the caller decides what to say about them.
 *
 * `documentIds` narrows to named documents; omission is the whole base. It is a bound
 * parameter list, not SQL built from ids, so nothing here can be injected through.
 */
export function listChunksForSearch(
  db: DrizzleDb,
  input: { dim: number; documentIds?: readonly string[] | undefined },
): StoredChunk[] {
  const comparable = eq(chunks.dim, input.dim);
  const where =
    input.documentIds === undefined || input.documentIds.length === 0
      ? comparable
      : and(comparable, inArray(chunks.documentId, [...input.documentIds]));

  return db
    .select({
      chunkId: chunks.id,
      documentId: chunks.documentId,
      documentTitle: documents.title,
      ordinal: chunks.ordinal,
      text: chunks.text,
      dim: chunks.dim,
      embedding: chunks.embedding,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(where)
    .orderBy(asc(chunks.documentId), asc(chunks.ordinal))
    .all();
}

/**
 * How many chunks exist at all, and how many of those match a width.
 *
 * One scan, and the reason it exists: "no results" and "every document was indexed with a
 * different embedding model" are different answers, and only the second one has a fix.
 */
export function countChunks(db: DrizzleDb, dim: number): { total: number; comparable: number } {
  const row = db.get<{ total: number; comparable: number }>(sql`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN dim = ${dim} THEN 1 ELSE 0 END), 0) AS comparable
    FROM chunks
  `);
  return { total: row?.total ?? 0, comparable: row?.comparable ?? 0 };
}

/** One chunk with its document's title, for expanding a citation. */
export interface ChunkWithTitle {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  text: string;
}

export function getChunk(db: DrizzleDb, chunkId: string): ChunkWithTitle | null {
  const row = db
    .select({
      chunkId: chunks.id,
      documentId: chunks.documentId,
      documentTitle: documents.title,
      ordinal: chunks.ordinal,
      text: chunks.text,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(eq(chunks.id, chunkId))
    .get();

  return row ?? null;
}

/** The citation for a stored chunk: the four fields a message keeps. */
export function toCitation(chunk: {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
}): Citation {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    ordinal: chunk.ordinal,
  };
}

/**
 * The citation list a message carries, parsed defensively.
 *
 * The column is JSON text written by this build. A row written by a newer build could carry
 * a shape this one does not know, and a whole thread must not fail to load over one bad
 * annotation, so anything that is not a list of four-field objects reads as "no
 * citations" — the same answer as a turn that used none.
 */
export function parseCitations(raw: string | null): Citation[] {
  if (raw === null || raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const citations: Citation[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const { chunkId, documentId, documentTitle, ordinal } = record;
    if (
      typeof chunkId !== "string" ||
      typeof documentId !== "string" ||
      typeof documentTitle !== "string" ||
      typeof ordinal !== "number" ||
      !Number.isInteger(ordinal)
    ) {
      continue;
    }
    citations.push({ chunkId, documentId, documentTitle, ordinal });
  }

  return citations;
}

/**
 * A `UNIQUE` violation as the driver reports it. better-sqlite3 puts the constraint name in
 * the message and the SQLite code on the error; both are checked so a different constraint
 * failure is not mistaken for "already indexed".
 */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(error.message);
}

import type { Attachment } from "@shared/ipc-contract";
import { sql } from "drizzle-orm";
import { AppError } from "../errors.js";
import type { DrizzleDb } from "./client.js";

/**
 * The `attachments` table, as main uses it.
 *
 * Migration 4 owns the schema; this module owns the four statements that touch it.
 * It deliberately declares no drizzle table object: `src/main/db/schema.ts` is not this
 * slice's to edit, and a second declaration of the same table is exactly the kind of
 * duplication that lets two definitions drift. The rows are read into the interfaces
 * below, which is the shape the rest of main consumes.
 *
 * An attachment is written in two steps. `insertAttachment` stores the metadata after the
 * bytes are already on disk, with no message; `attachToUserMessage` links it to the user
 * turn at send time. That gap is deliberate — a file the user attached and then deleted
 * from the composer is a row with no message, which is harmless, whereas a copy that
 * arrives after the message is written would have to be appended to a turn already sent.
 */

/** One row as written once the copy exists, before it belongs to any message. */
export interface NewAttachment {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  kind: "image" | "document";
  storedPath: string;
}

/** A row as stored, including where its bytes are. `storedPath` never leaves main. */
export interface StoredAttachmentRow extends NewAttachment {
  threadId: string | null;
  messageId: string | null;
}

interface AttachmentRow {
  id: string;
  thread_id: string | null;
  message_id: string | null;
  filename: string;
  mime: string;
  size_bytes: number;
  /** Constrained by a CHECK in migration 4, so the row type is the union. */
  kind: "image" | "document";
  stored_path: string;
}

function toStoredAttachment(row: AttachmentRow): StoredAttachmentRow {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    kind: row.kind,
    storedPath: row.stored_path,
    threadId: row.thread_id,
    messageId: row.message_id,
  };
}

/** The contract's shape: no path, no thread, no message. */
function toAttachment(row: StoredAttachmentRow): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
  };
}

/** The row for an accepted file. Its `thread_id` and `message_id` start null. */
export function insertAttachment(db: DrizzleDb, input: NewAttachment): void {
  db.run(sql`
    INSERT INTO attachments (id, filename, mime, size_bytes, kind, stored_path)
    VALUES (
      ${input.id},
      ${input.filename},
      ${input.mime},
      ${input.sizeBytes},
      ${input.kind},
      ${input.storedPath}
    )
  `);
}

export function getAttachmentById(db: DrizzleDb, id: string): StoredAttachmentRow | null {
  const row = db.get<AttachmentRow>(sql`
    SELECT id, thread_id, message_id, filename, mime, size_bytes, kind, stored_path
    FROM attachments
    WHERE id = ${id}
  `);
  return row === undefined ? null : toStoredAttachment(row);
}

/**
 * Every attachment on the given messages, in the order it was attached, grouped by
 * message.
 *
 * One query for the whole thread rather than one per message: a restored conversation
 * with attachments is a read on the critical path of opening a thread, and N+1 there
 * would be N round trips through SQLite for a screen that is waiting on all of them.
 *
 * A message with no attachments has no key. Callers read `.get(id) ?? []`, which also
 * makes "the message is not in this thread" and "the message has no files" the same
 * answer, as they should be.
 */
export function listAttachmentsForMessages(
  db: DrizzleDb,
  messageIds: readonly string[],
): Map<string, Attachment[]> {
  const byMessage = new Map<string, Attachment[]>();
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return byMessage;

  const rows = db.all<AttachmentRow>(sql`
    SELECT id, thread_id, message_id, filename, mime, size_bytes, kind, stored_path
    FROM attachments
    WHERE message_id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    ORDER BY message_id, rowid
  `);

  for (const row of rows) {
    if (row.message_id === null) continue;
    const attachment = toAttachment(toStoredAttachment(row));
    const existing = byMessage.get(row.message_id);
    if (existing === undefined) byMessage.set(row.message_id, [attachment]);
    else existing.push(attachment);
  }

  return byMessage;
}

/**
 * Points the given attachments at one message, and returns how many rows moved.
 *
 * The guard is in the WHERE clause, not in a preceding SELECT: a row that already belongs
 * to a *different* message is left alone, so two sends racing over the same id cannot both
 * claim it, and re-linking the same message is a no-op rather than a duplicate.
 *
 * The thread is written alongside the message because the sidebar joins on it; both are
 * derived from the message here rather than trusted from the caller.
 */
export function linkAttachmentsToMessage(
  db: DrizzleDb,
  ids: readonly string[],
  messageId: string,
  threadId: string,
): number {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;

  const result = db.run(sql`
    UPDATE attachments
    SET message_id = ${messageId}, thread_id = ${threadId}
    WHERE id IN (${sql.join(
      unique.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND (message_id IS NULL OR message_id = ${messageId})
  `);

  return Number(result.changes);
}

/**
 * The send-time half: what `chat.send` does with `attachmentIds` after the user message
 * row exists.
 *
 * Two failures are distinct on purpose. An id this process never issued is a
 * BAD_REQUEST — the request names something that cannot be honoured, and retrying it
 * unchanged will fail the same way. An id that belongs to another message is a CONFLICT —
 * the attachment exists, but taking it would steal the file from the turn that already
 * shows it.
 *
 * Idempotent: calling it twice with the same ids leaves the rows linked once and returns
 * the same list.
 *
 * Call this inside the caller's transaction when the message row is written in the same
 * unit of work — the message must exist for the foreign key, so the two writes belong
 * together.
 */
export function attachToUserMessage(
  db: DrizzleDb,
  ids: readonly string[],
  messageId: string,
  threadId: string,
): Attachment[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];

  const known = new Set(
    db
      .all<{ id: string }>(sql`
        SELECT id FROM attachments
        WHERE id IN (${sql.join(
          unique.map((id) => sql`${id}`),
          sql`, `,
        )})
      `)
      .map((row) => row.id),
  );

  const unknown = unique.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new AppError("BAD_REQUEST", "attachment not found", {
      details: { reason: "unknown_attachment", ids: unknown },
    });
  }

  const linked = linkAttachmentsToMessage(db, unique, messageId, threadId);
  if (linked !== unique.length) {
    throw new AppError("CONFLICT", "attachment already belongs to another message", {
      details: { reason: "attachment_taken", messageId },
    });
  }

  return (listAttachmentsForMessages(db, [messageId]).get(messageId) ?? []).filter((attachment) =>
    unique.includes(attachment.id),
  );
}

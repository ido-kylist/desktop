import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILES,
  MAX_PREVIEW_BYTES,
  previewAttachment,
} from "../../src/main/attachments/store.js";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";
import { MIGRATIONS } from "../../src/main/db/migrations.js";
import { createThread, insertMessage } from "../../src/main/db/repo.js";
import {
  attachToUserMessage,
  getAttachmentById,
  insertAttachment,
  listAttachmentsForMessages,
} from "../../src/main/db/repo-attachments.js";
import { AppError } from "../../src/main/errors.js";
import { contracts } from "../../src/shared/ipc-contract";

/**
 * D4 against a real file system and a real SQLite file.
 *
 * Nothing is mocked. `copyFile`, `chmod`, the foreign keys on `attachments`, and the
 * CHECK on `kind` are all things a mock would happily disagree with — and the two halves of
 * this feature (a file on disk, a row in the database) only fail together in exactly the
 * cases worth catching: a refused batch that left a copy behind, a copy whose mode is world
 * readable, a link that moved a file off the message that already had it.
 *
 * Every test seeds its own thread and message; the ids are uuids, so tests cannot collide
 * even though the connection is shared for the file.
 */

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

let tempDir = "";
let sourceDir = "";
let rootDir = "";
let conn: Db;
let db: DrizzleDb;

/** A file to attach, named so its extension decides its kind. */
async function sourceFile(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(sourceDir, name);
  await writeFile(path, bytes);
  return path;
}

/** A file of `sizeBytes` zeros. Sparse, so a 25 MiB fixture costs a truncate, not a write. */
async function sparseFile(name: string, sizeBytes: number): Promise<string> {
  const path = join(sourceDir, name);
  const handle = await open(path, "w");
  await handle.truncate(sizeBytes);
  await handle.close();
  return path;
}

function seedTurn(): { threadId: string; messageId: string } {
  const threadId = randomUUID();
  createThread(db, { id: threadId });
  const messageId = randomUUID();
  insertMessage(db, {
    id: messageId,
    threadId,
    parentId: null,
    role: "user",
    text: "look at this",
    model: null,
  });
  return { threadId, messageId };
}

/** Stores one attachment and records its row, the way `attachments.add` does. */
async function storeOne(name: string, bytes: Uint8Array): Promise<string> {
  const path = await sourceFile(name, bytes);
  const [record] = await addAttachments([path], { rootDir });
  if (record === undefined) throw new Error("store returned nothing");
  insertAttachment(db, record);
  return record.id;
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

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cleon-d4-"));
  sourceDir = join(tempDir, "sources");
  rootDir = join(tempDir, "attachments");
  await mkdir(sourceDir, { recursive: true });

  conn = openDatabase(join(tempDir, "cleon.db"));
  db = createDb(conn);
});

afterAll(async () => {
  closeDatabase();
  if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // The copies are per-test: the "nothing was left behind" assertion reads this directory,
  // and a file from a previous test would be indistinguishable from a leak.
  await rm(rootDir, { recursive: true, force: true });
});

describe("the stored copy", () => {
  it("copies the file under a uuid name, keeps the original name, and returns metadata", async () => {
    const path = await sourceFile("shot.png", PNG_BYTES);

    const [record] = await addAttachments([path], { rootDir });
    expect(record).toBeDefined();
    if (record === undefined) return;

    expect(record).toMatchObject({
      filename: "shot.png",
      mime: "image/png",
      sizeBytes: PNG_BYTES.byteLength,
      kind: "image",
    });
    // The contract's id is a uuid, because it is a row id and a file name at once.
    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // The copy is named by id, not by the user's filename: two `shot.png` drops must not
    // fight over one path, and the original name lives in the row.
    expect(basename(record.storedPath)).toBe(`${record.id}.png`);
    expect(await readFile(record.storedPath)).toEqual(PNG_BYTES);
  });

  it("stores the copy 0600: it is the user's document, not the machine's", async () => {
    const path = await sourceFile("notes.md", Buffer.from("# notes\n"));
    const [record] = await addAttachments([path], { rootDir });
    expect(record).toBeDefined();
    if (record === undefined) return;

    const mode = (await stat(record.storedPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("classifies a document on the way in, from the same table as the cap checks", async () => {
    const path = await sourceFile("paper.pdf", PDF_BYTES);
    const [record] = await addAttachments([path], { rootDir });

    expect(record).toMatchObject({ kind: "document", mime: "application/pdf" });
  });

  it("leaves nothing on disk when the batch is refused", async () => {
    // One good file and one that is over the cap. Validation runs before the first copy,
    // so a rejected call must be indistinguishable from one that never happened.
    const good = await sourceFile("good.png", PNG_BYTES);
    const huge = await sparseFile("huge.pdf", MAX_ATTACHMENT_BYTES + 1);

    await expect(addAttachments([good, huge], { rootDir })).rejects.toBeInstanceOf(AppError);

    // Either the directory was never created, or it exists and is empty.
    const left = await readdir(rootDir).catch(() => [] as string[]);
    expect(left).toEqual([]);
  });
});

describe("the caps, as refusals", () => {
  it("refuses a file over 25 MiB, naming it and the limit", async () => {
    const huge = await sparseFile("huge.pdf", MAX_ATTACHMENT_BYTES + 1);

    await expect(addAttachments([huge], { rootDir })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: {
        reason: "too_large",
        filename: "huge.pdf",
        limitBytes: MAX_ATTACHMENT_BYTES,
      },
    });
  });

  it("accepts a file exactly at the limit, so the cap is inclusive", async () => {
    const exact = await sparseFile("exact.pdf", MAX_ATTACHMENT_BYTES);
    const [record] = await addAttachments([exact], { rootDir });

    expect(record?.sizeBytes).toBe(MAX_ATTACHMENT_BYTES);
  });

  it("refuses more than ten files in one call, with the limit", async () => {
    const paths = await Promise.all(
      Array.from({ length: MAX_ATTACHMENT_FILES + 1 }, (_unused, index) =>
        sourceFile(`shot-${index}.png`, PNG_BYTES),
      ),
    );

    await expect(addAttachments(paths, { rootDir })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "too_many", limit: MAX_ATTACHMENT_FILES },
    });
  });

  it("takes exactly ten, so the batch cap is inclusive too", async () => {
    const paths = await Promise.all(
      Array.from({ length: MAX_ATTACHMENT_FILES }, (_unused, index) =>
        sourceFile(`batch-${index}.png`, PNG_BYTES),
      ),
    );

    const stored = await addAttachments(paths, { rootDir });
    expect(stored).toHaveLength(MAX_ATTACHMENT_FILES);
    expect(new Set(stored.map((record) => record.id)).size).toBe(MAX_ATTACHMENT_FILES);
    expect(new Set(stored.map((record) => record.storedPath)).size).toBe(MAX_ATTACHMENT_FILES);
  });

  it("refuses an extension it cannot classify", async () => {
    const path = await sourceFile("archive.zip", Buffer.from("PK\u0003\u0004"));

    await expect(addAttachments([path], { rootDir })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "unsupported_type", filename: "archive.zip" },
    });
  });

  it("is NOT_FOUND for a path that does not exist, and names it", async () => {
    const missing = join(sourceDir, "ghost.png");

    await expect(addAttachments([missing], { rootDir })).rejects.toMatchObject({
      code: "NOT_FOUND",
      details: { path: missing },
    });
  });
});

describe("store > db > list", () => {
  it("round-trips an attachment onto a user message", async () => {
    const { threadId, messageId } = seedTurn();
    const path = await sourceFile("shot.png", PNG_BYTES);

    const [record] = await addAttachments([path], { rootDir });
    expect(record).toBeDefined();
    if (record === undefined) return;
    insertAttachment(db, record);

    const linked = attachToUserMessage(db, [record.id], messageId, threadId);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ id: record.id, filename: "shot.png", kind: "image" });
    // The response is the contract's shape: no stored path, no thread, no message.
    expect(Object.keys(linked[0] ?? {}).sort()).toEqual([
      "filename",
      "id",
      "kind",
      "mime",
      "sizeBytes",
    ]);

    const listed = listAttachmentsForMessages(db, [messageId]).get(messageId) ?? [];
    expect(listed).toEqual(linked);

    // And the row really carries the thread and the message, which is what the sidebar and
    // the restore read join on.
    const row = getAttachmentById(db, record.id);
    expect(row).toMatchObject({ threadId, messageId, storedPath: record.storedPath });
  });

  it("satisfies the frozen attachments contract", async () => {
    const { threadId, messageId } = seedTurn();
    const path = await sourceFile("shot.png", PNG_BYTES);

    const [record] = await addAttachments([path], { rootDir });
    expect(record).toBeDefined();
    if (record === undefined) return;
    insertAttachment(db, record);
    attachToUserMessage(db, [record.id], messageId, threadId);

    const listed = listAttachmentsForMessages(db, [messageId]).get(messageId) ?? [];
    // uuid id, known mime, non-negative size, one of the two kinds — parsed, not eyeballed.
    expect(() =>
      contracts["attachments.add"].response.parse({ attachments: listed }),
    ).not.toThrow();
  });

  it("groups a whole thread's attachments in one read, oldest first per message", async () => {
    const { threadId, messageId } = seedTurn();
    const second = seedTurn();
    const third = seedTurn();

    const first = await storeOne("one.png", PNG_BYTES);
    const secondId = await storeOne("two.pdf", PDF_BYTES);
    await storeOne("three.md", Buffer.from("# three\n"));

    attachToUserMessage(db, [first, secondId], messageId, threadId);

    const listed = listAttachmentsForMessages(db, [messageId, second.messageId, third.messageId]);
    expect(listed.get(messageId)?.map((attachment) => attachment.filename)).toEqual([
      "one.png",
      "two.pdf",
    ]);
    // A message with no attachments has no key: "nothing attached" and "not this thread"
    // are the same answer, and callers read `.get(id) ?? []`.
    expect(listed.has(second.messageId)).toBe(false);
    expect(listed.has(third.messageId)).toBe(false);
  });

  it("returns no key at all for an empty list of messages", () => {
    expect(listAttachmentsForMessages(db, []).size).toBe(0);
  });

  it("is idempotent: linking the same message twice leaves one link", async () => {
    const { threadId, messageId } = seedTurn();
    const id = await storeOne("shot.png", PNG_BYTES);

    const once = attachToUserMessage(db, [id], messageId, threadId);
    const twice = attachToUserMessage(db, [id], messageId, threadId);

    expect(twice).toEqual(once);
    expect(listAttachmentsForMessages(db, [messageId]).get(messageId)).toHaveLength(1);
  });

  it("is BAD_REQUEST for an id this process never issued", async () => {
    const { threadId, messageId } = seedTurn();
    const ghost = randomUUID();

    const error = expectAppError(
      () => attachToUserMessage(db, [ghost], messageId, threadId),
      "BAD_REQUEST",
    );
    expect(error.details).toEqual({ reason: "unknown_attachment", ids: [ghost] });
  });

  it("is CONFLICT rather than moving a file off the message that already shows it", async () => {
    const first = seedTurn();
    const second = seedTurn();
    const id = await storeOne("shot.png", PNG_BYTES);

    attachToUserMessage(db, [id], first.messageId, first.threadId);

    const error = expectAppError(
      () => attachToUserMessage(db, [id], second.messageId, second.threadId),
      "CONFLICT",
    );
    expect(error.details).toMatchObject({ reason: "attachment_taken" });

    // The first message still has it, and the second never got it.
    expect(listAttachmentsForMessages(db, [first.messageId]).get(first.messageId)).toHaveLength(1);
    expect(listAttachmentsForMessages(db, [second.messageId]).has(second.messageId)).toBe(false);
  });

  it("links nothing, and says so, for an empty id list", () => {
    const { threadId, messageId } = seedTurn();
    expect(attachToUserMessage(db, [], messageId, threadId)).toEqual([]);
  });
});

describe("preview", () => {
  it("inlines a small image as a data URL with its own mime", async () => {
    const path = await sourceFile("shot.png", PNG_BYTES);
    const [record] = await addAttachments([path], { rootDir });
    expect(record).toBeDefined();
    if (record === undefined) return;
    insertAttachment(db, record);

    const row = getAttachmentById(db, record.id);
    expect(row).not.toBeNull();
    if (row === null) return;

    const preview = await previewAttachment(row, { rootDir });
    expect(preview.mime).toBe("image/png");
    expect(preview.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
    // The bytes are the file's, base64-encoded — not a placeholder.
    expect(preview.dataUrl).toContain(PNG_BYTES.toString("base64"));
  });

  it("returns no data URL for a document, but still says what it is", async () => {
    const path = await sourceFile("paper.pdf", PDF_BYTES);
    const [record] = await addAttachments([path], { rootDir });
    expect(record).toBeDefined();
    if (record === undefined) return;

    const preview = await previewAttachment(record, { rootDir });
    expect(preview).toEqual({ dataUrl: null, mime: "application/pdf" });
  });

  it("returns no data URL for an image over the inline limit", async () => {
    const path = await sparseFile("huge.png", MAX_PREVIEW_BYTES + 1);
    const [record] = await addAttachments([path], { rootDir });
    expect(record).toBeDefined();
    if (record === undefined) return;

    expect(await previewAttachment(record, { rootDir })).toEqual({
      dataUrl: null,
      mime: "image/png",
    });
  });

  it("is NOT_FOUND for a copy the disk no longer has", async () => {
    const path = await sourceFile("shot.png", PNG_BYTES);
    const [record] = await addAttachments([path], { rootDir });
    expect(record).toBeDefined();
    if (record === undefined) return;

    await rm(record.storedPath, { force: true });

    await expect(previewAttachment(record, { rootDir })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("the schema this slice relies on", () => {
  it("has migration 4 applied and an attachments table with the columns the repo uses", () => {
    const latest = MIGRATIONS.at(-1)?.version;
    // Not an equality: D6's migration 5 is applied after this one, and the claim this
    // test makes is "migration 4 is applied", not "nothing has been added since".
    expect(latest).toBeGreaterThanOrEqual(4);

    const columns = conn.prepare("PRAGMA table_info(attachments)").all() as { name: string }[];
    expect(columns.map((column) => column.name).sort()).toEqual([
      "created_at",
      "filename",
      "id",
      "kind",
      "message_id",
      "mime",
      "size_bytes",
      "stored_path",
      "thread_id",
    ]);
  });

  it("refuses a kind outside the CHECK, so a bad row cannot reach the UI", () => {
    expect(() =>
      conn
        .prepare(
          "INSERT INTO attachments (id, filename, mime, size_bytes, kind, stored_path) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), "x.png", "image/png", 1, "video", "/tmp/x.png"),
    ).toThrow();
  });
});

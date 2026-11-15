import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join, normalize, sep } from "node:path";
import type { Attachment } from "@shared/ipc-contract";
import { AppError } from "../errors.js";

/**
 * Where an attached file goes once main has accepted it.
 *
 * Two things live here and nowhere else: the caps, and the extension table that
 * decides what a file *is*. Both are answerable without touching the disk, which is
 * what lets the renderer's error states be asserted without a file system.
 *
 * The renderer never reads a file. It hands over paths it was given, and gets back
 * metadata: name, mime, size, kind. The bytes stay in main and in the copy this module
 * makes (invariant 3 in spirit — main owns the file system for the same reason it owns
 * the SQL).
 */

/** The most files one call will take. Mirrors `chat.send.attachmentIds` (`.max(10)`). */
export const MAX_ATTACHMENT_FILES = 10;

/** 25 MiB per file. Large enough for a screenshot or a PDF, small enough to copy twice. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Above this, `attachments.preview` returns no inline image.
 *
 * A data URL is a 4/3-expanded copy of the file living in the renderer's heap until the
 * chip unmounts; 1 MiB is the point where a thumbnail stops being worth that, and the
 * chip falls back to a name-and-size row rather than a picture.
 */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

export type AttachmentKind = "image" | "document";

/**
 * Why a call was refused, carried in `details.reason`.
 *
 * `details` is an open record on the wire, so these strings are a convention rather than
 * a schema — but the composer renders a different state for each, and a test asserts
 * they stay distinct. Renaming one silently is a UI regression, so they are named here.
 */
export type AttachmentRejectReason = "too_many" | "too_large" | "unsupported_type";

/**
 * The closed set of accepted extensions. Everything else is `unsupported_type`.
 *
 * Extension, not content sniffing: a file's magic bytes are a promise about its
 * contents, while the extension is what the user sees and what every other app on their
 * machine agrees on. Sniffing would also mean reading up to 25 MiB of untrusted bytes to
 * answer a question the name already answered.
 */
const SUPPORTED: Readonly<Record<string, { kind: AttachmentKind; mime: string }>> = {
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".webp": { kind: "image", mime: "image/webp" },
  ".gif": { kind: "image", mime: "image/gif" },
  ".pdf": { kind: "document", mime: "application/pdf" },
  ".txt": { kind: "document", mime: "text/plain" },
  ".md": { kind: "document", mime: "text/markdown" },
};

/** What the picker offers. A hint for the file dialog; main stays the authority. */
export const ATTACHMENT_EXTENSIONS: readonly string[] = Object.keys(SUPPORTED);

/**
 * The kind and mime for a filename, or null when the extension is not accepted.
 *
 * Case-insensitive: a camera roll and a `Save As…` dialog both produce `.JPG`, and
 * refusing it would be a bug the user experiences as "this app can't open my photos".
 */
export function kindForFilename(filename: string): { kind: AttachmentKind; mime: string } | null {
  return SUPPORTED[extname(filename).toLowerCase()] ?? null;
}

/** The batch cap. Checked before anything is read, so 11 paths cost 11 strings. */
export function isTooMany(count: number): boolean {
  return count > MAX_ATTACHMENT_FILES;
}

/** The per-file cap. Checked against the copy's source, not the copy. */
export function isTooLarge(sizeBytes: number): boolean {
  return sizeBytes > MAX_ATTACHMENT_BYTES;
}

/**
 * A stored file, plus where its bytes are.
 *
 * The extra field is main's alone: `toAttachmentMeta` is the boundary, and nothing that
 * crosses it carries a path. A structural superset of the contract's `Attachment`, so
 * `addAttachments` still satisfies "returns attachments".
 */
export interface StoredAttachment extends Attachment {
  /** Absolute path of the copy under the attachments root. Never crosses the boundary. */
  storedPath: string;
}

export interface StoreOptions {
  /** `<userData>/attachments`. The only directory this module writes to. */
  rootDir: string;
}

/** What the preview needs to know about a row; the database's shape, not the contract's. */
export interface PreviewSource {
  storedPath: string;
  mime: string;
  sizeBytes: number;
  kind: AttachmentKind;
}

interface InspectedFile {
  path: string;
  filename: string;
  kind: AttachmentKind;
  mime: string;
  sizeBytes: number;
}

/**
 * Copies each accepted file under the attachments root and returns its metadata.
 *
 * Validation for the whole batch runs **before** the first copy: a call that is going to
 * fail must not leave half its files on disk for a message that will never exist. If a
 * copy itself fails (a full disk, a file that vanished between stat and copy), the copies
 * already made are removed for the same reason.
 *
 * The copy carries mode 0600. It is the user's document sitting in the app's data
 * directory; nothing else on the machine has any business reading it.
 */
export async function addAttachments(
  paths: readonly string[],
  options: StoreOptions,
): Promise<StoredAttachment[]> {
  if (isTooMany(paths.length)) {
    throw new AppError(
      "BAD_REQUEST",
      `At most ${MAX_ATTACHMENT_FILES} files can be attached at once`,
      { details: { reason: "too_many", limit: MAX_ATTACHMENT_FILES } },
    );
  }

  const inspected: InspectedFile[] = [];
  for (const path of paths) {
    inspected.push(await inspect(path));
  }

  await mkdir(options.rootDir, { recursive: true });

  const stored: StoredAttachment[] = [];
  try {
    for (const file of inspected) {
      // A uuid name, not the user's filename: two `screenshot.png` drops must not fight
      // over one path, and the original name is preserved in the row where it is read.
      const id = randomUUID();
      const storedPath = join(options.rootDir, `${id}${extname(file.filename).toLowerCase()}`);
      await copyFile(file.path, storedPath);
      await chmod(storedPath, 0o600);
      stored.push({
        id,
        filename: file.filename,
        mime: file.mime,
        sizeBytes: file.sizeBytes,
        kind: file.kind,
        storedPath,
      });
    }
  } catch (error) {
    await Promise.all(stored.map((file) => rm(file.storedPath, { force: true })));
    throw error;
  }

  return stored;
}

/** The boundary shape. `storedPath` is left behind, deliberately. */
export function toAttachmentMeta(record: StoredAttachment): Attachment {
  return {
    id: record.id,
    filename: record.filename,
    mime: record.mime,
    sizeBytes: record.sizeBytes,
    kind: record.kind,
  };
}

/**
 * A data URL for a small image, and `null` for everything else.
 *
 * The contract allows a null `dataUrl` on purpose: a PDF, a 12 MiB photo, and a file the
 * disk no longer has are three different reasons not to inline anything, and the chip
 * only needs to know that it must render itself as text.
 */
export async function previewAttachment(
  record: PreviewSource,
  options: StoreOptions,
): Promise<{ dataUrl: string | null; mime: string }> {
  if (record.kind !== "image" || record.sizeBytes > MAX_PREVIEW_BYTES) {
    return { dataUrl: null, mime: record.mime };
  }

  // The path came from this app's own row, but it is still a path read from the disk and
  // handed back to the renderer. A row edited out from under us must not turn into a way
  // to read `/etc/hosts` into a web page.
  if (!isInsideRoot(options.rootDir, record.storedPath)) {
    throw new AppError("NOT_FOUND", "attachment is outside the attachments directory", {
      details: { path: record.storedPath },
    });
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(record.storedPath);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new AppError("NOT_FOUND", `File not found: ${record.storedPath}`, {
        details: { path: record.storedPath },
      });
    }
    throw error;
  }

  // The row said 200 KiB; the file may not agree. The recorded size is a fast path, this
  // is the actual promise.
  if (bytes.byteLength > MAX_PREVIEW_BYTES) {
    return { dataUrl: null, mime: record.mime };
  }

  return { dataUrl: `data:${record.mime};base64,${bytes.toString("base64")}`, mime: record.mime };
}

/** `candidate` is `root` or below it. Both sides are normalised first, so `..` cannot win. */
function isInsideRoot(rootDir: string, candidate: string): boolean {
  const root = normalize(rootDir);
  return normalize(candidate).startsWith(root + sep);
}

async function inspect(path: string): Promise<InspectedFile> {
  let stats: Stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new AppError("NOT_FOUND", `File not found: ${path}`, { details: { path } });
    }
    throw error;
  }

  const filename = basename(path);
  const supported = kindForFilename(filename);
  // A directory or a socket has no extension worth trusting, and neither is a file the
  // model can be shown. Both are the same answer to the user: that is not a file we take.
  if (!stats.isFile() || supported === null) {
    throw new AppError("BAD_REQUEST", `Unsupported attachment type: ${filename}`, {
      details: { reason: "unsupported_type", filename },
    });
  }

  if (isTooLarge(stats.size)) {
    throw new AppError("BAD_REQUEST", `${filename} is larger than ${MAX_ATTACHMENT_BYTES} bytes`, {
      details: { reason: "too_large", filename, limitBytes: MAX_ATTACHMENT_BYTES },
    });
  }

  return { path, filename, kind: supported.kind, mime: supported.mime, sizeBytes: stats.size };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

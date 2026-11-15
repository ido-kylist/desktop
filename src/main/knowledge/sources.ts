import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  isTooLarge,
  isTooMany,
  kindForFilename,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILES,
} from "../attachments/store.js";
import { AppError } from "../errors.js";

/**
 * Turning file paths into text the app can index.
 *
 * The caps and the extension table are the attachment module's — `isTooMany`, `isTooLarge`
 * and `kindForFilename` are imported, not reimplemented. That is the point: a file this app
 * refuses to attach must not be a file it silently indexes, and two lists that disagree
 * about `.md` would be a defect with no author to blame.
 *
 * **PDFs are refused, and that is a deviation.** `kindForFilename` classifies `.pdf` as a
 * document, but a PDF's bytes are a container of compressed streams and glyph indices, not
 * text. Reading it as UTF-8 produces a page of mojibake that chunks, embeds, and retrieves
 * — all of it wrong, none of it detectable from the result. Honest extraction needs a
 * parser or an OCR step, neither of which is in this slice's dependency budget, so the file
 * is refused by name with a reason the panel can render. `docs/DECISIONS.md` records it and
 * `BACKLOG.md` carries the follow-up.
 *
 * Copying is the same trade the attachments store makes: the index is a snapshot of the
 * file at the moment it was added. Indexing in place would mean a file edited or deleted
 * later leaves a document whose text no longer matches its source, with nothing to say so.
 */

/** The knowledge directory for a user-data directory. */
export function knowledgeRoot(userDataDir: string): string {
  return join(userDataDir, "knowledge");
}

/** One accepted file: where it is now, what it was, and the text to index. */
export interface KnowledgeSource {
  /** The document id. Also the copy's filename, so a delete can find it. */
  id: string;
  title: string;
  sourcePath: string;
  mime: string;
  bytes: number;
  text: string;
  /** Absolute path of this app's own copy. Never crosses the boundary. */
  storedPath: string;
}

export interface CollectOptions {
  /** `<userData>/knowledge`. The only directory this module writes to. */
  rootDir: string;
}

/**
 * Validates the whole batch, then copies, then reads.
 *
 * Validation first, for the same reason the attachments store does it first: a call that is
 * going to be refused must not leave half its files on disk for a document that will never
 * exist. If a copy or a read fails afterwards, the copies already made are removed.
 */
export async function collectSources(
  paths: readonly string[],
  options: CollectOptions,
): Promise<KnowledgeSource[]> {
  if (isTooMany(paths.length)) {
    throw new AppError(
      "BAD_REQUEST",
      `At most ${MAX_ATTACHMENT_FILES} documents can be added at once`,
      { details: { reason: "too_many", limit: MAX_ATTACHMENT_FILES } },
    );
  }

  const inspected: {
    path: string;
    filename: string;
    mime: string;
    bytes: number;
  }[] = [];

  for (const path of paths) {
    inspected.push(await inspect(path));
  }

  await mkdir(options.rootDir, { recursive: true });

  const sources: KnowledgeSource[] = [];
  /**
   * Every copy made so far, tracked separately from `sources` because it is pushed *before*
   * the read. The read is the step that can fail on the file just copied (an empty document is
   * a refusal), and a cleanup list that only learned about a copy after the read would leave
   * exactly that file on disk. The test that caught this asserts the directory is empty.
   */
  const copied: string[] = [];
  try {
    for (const file of inspected) {
      const id = randomUUID();
      const storedPath = join(options.rootDir, `${id}${extname(file.filename).toLowerCase()}`);
      await copyFile(file.path, storedPath);
      copied.push(storedPath);
      await chmod(storedPath, 0o600);

      const text = await readFile(storedPath, "utf8");
      if (text.trim() === "") {
        throw new AppError("BAD_REQUEST", `${file.filename} has no text to index`, {
          details: { reason: "empty_document", filename: file.filename },
        });
      }

      sources.push({
        id,
        // The filename is the title: a document's own name is the only label the user gave
        // it, and inventing "Untitled 3" would make a list of six files unreadable.
        title: file.filename,
        sourcePath: file.path,
        mime: file.mime,
        bytes: file.bytes,
        text,
        storedPath,
      });
    }
  } catch (error) {
    await Promise.all(copied.map((storedPath) => rm(storedPath, { force: true })));
    throw error;
  }

  return sources;
}

/** Removes a document's stored copy. Missing is success: the row is already gone. */
export async function removeSource(storedPath: string): Promise<void> {
  await rm(storedPath, { force: true });
}

/** The copy a document id names, if it is still in the knowledge directory. */
export function storedPathFor(rootDir: string, documentId: string, sourcePath: string): string {
  return join(rootDir, `${documentId}${extname(sourcePath).toLowerCase()}`);
}

interface Inspected {
  path: string;
  filename: string;
  mime: string;
  bytes: number;
}

async function inspect(path: string): Promise<Inspected> {
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
  if (!stats.isFile() || supported === null) {
    throw new AppError("BAD_REQUEST", `Unsupported document type: ${filename}`, {
      details: { reason: "unsupported_type", filename },
    });
  }

  const mime = fileTextMime(filename);
  if (mime === null) {
    throw new AppError(
      "BAD_REQUEST",
      `${filename} cannot be read as text. Add a .txt or .md file; PDFs need text extraction, which this build does not have.`,
      { details: { reason: "not_readable_text", filename } },
    );
  }

  if (isTooLarge(stats.size)) {
    throw new AppError("BAD_REQUEST", `${filename} is larger than ${MAX_ATTACHMENT_BYTES} bytes`, {
      details: { reason: "too_large", filename, limitBytes: MAX_ATTACHMENT_BYTES },
    });
  }

  return { path, filename, mime, bytes: stats.size };
}

/**
 * The mime for a filename this slice can read, or null.
 *
 * A table of its own rather than a filter over the attachment one, because the two answer
 * different questions: "will the app take this file" and "can it read this file as text". A
 * filter would have to hard-code the exception, which is the same table with the reasoning
 * thrown away.
 */
const TEXT_MIMES: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
};

function fileTextMime(filename: string): string | null {
  return TEXT_MIMES[extname(filename).toLowerCase()] ?? null;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

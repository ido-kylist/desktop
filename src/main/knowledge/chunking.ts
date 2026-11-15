/**
 * Splitting a document into retrievable pieces.
 *
 * A pure function over a string, and nothing else. It is separated from ingestion for the
 * same reason the SSE parser is separated from the transport: the interesting failures —
 * a paragraph larger than a window, an emoji on a boundary, a file that is only
 * whitespace — are properties of the split, and they can be asserted without a provider,
 * a disk, or a database.
 *
 * **Why these numbers.** A chunk is the unit that gets embedded and then pasted into a
 * prompt, so it has to be big enough to answer a question from and small enough that five
 * of them are not the whole context window. 800 characters is roughly 200 tokens of
 * English prose: two or three paragraphs, or one dense one. The 120-character overlap
 * exists so a sentence that straddles a boundary appears whole in at least one window —
 * without it, "the total is 42" can be split into "the total is" and "42", and neither
 * retrieves well.
 *
 * **Why paragraph boundaries.** Prose is written in paragraphs, and a chunk that starts
 * mid-sentence is a worse prompt than one that starts at a break. Paragraphs are therefore
 * the preferred cut; a single paragraph larger than the window is the exception, and it is
 * cut by character with the overlap applied so no stretch of text is lost between windows.
 *
 * **Why code points, not UTF-16 units.** `text.length` counts surrogate pairs as two, so a
 * boundary computed on it can land between the halves of one and produce two unpaired
 * surrogates — the chunk, once embedded, is then a different string than the one on disk.
 * Every length and every cut here is in code points (`Array.from`), which cannot split a
 * scalar value.
 */

/** The window a chunk targets, in code points. */
export const CHUNK_SIZE = 800;

/** How much of the previous window a hard-split chunk repeats, in code points. */
export const CHUNK_OVERLAP = 120;

export interface ChunkOptions {
  /** Defaults to `CHUNK_SIZE`. A hard-split window never exceeds it. */
  size?: number;
  /** Defaults to `CHUNK_OVERLAP`. Clamped to `size - 1`, so the stride is never zero. */
  overlap?: number;
}

/**
 * The document as chunks, in reading order.
 *
 * Empty or whitespace-only input is `[]`: there is nothing to embed, and a chunk of spaces
 * would be a row that matches nothing and costs a request to store.
 *
 * Line endings are normalised first, so `\r\n\r\n` and `\n\n` are the same break. The
 * original file is untouched — this function returns strings, it does not rewrite anything.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = Math.max(1, Math.floor(options.size ?? CHUNK_SIZE));
  // A stride of zero would loop forever, so the overlap can never reach the window.
  const overlap = Math.min(Math.max(0, Math.floor(options.overlap ?? CHUNK_OVERLAP)), size - 1);

  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];

  for (const paragraph of paragraphs) {
    const points = Array.from(paragraph);

    // A paragraph that does not fit in one window is cut by character. It is flushed on
    // its own: gluing half of it to the previous chunk would make the overlap accounting
    // ambiguous, and the windows already carry the overlap the split needs.
    if (points.length > size) {
      for (const window of hardSplit(points, size, overlap)) chunks.push(window);
      continue;
    }

    const last = chunks.at(-1);
    if (last !== undefined) {
      const joined = `${last}\n\n${paragraph}`;
      if (Array.from(joined).length <= size) {
        chunks[chunks.length - 1] = joined;
        continue;
      }
      // A new chunk, seeded with the tail of the previous one so a sentence that spans the
      // paragraph break is retrievable from either side. The seed is trimmed to whatever
      // room is left after the paragraph, and dropped when there is none.
      const tail = overlapTail(last, Math.min(overlap, size - points.length - 2));
      chunks.push(tail === "" ? paragraph : `${tail}\n\n${paragraph}`);
      continue;
    }

    chunks.push(paragraph);
  }

  return chunks;
}

/**
 * The document's paragraphs, in order.
 *
 * A paragraph is one or more non-empty lines between blank lines: a single newline is a
 * line wrap inside a thought, not a break between thoughts, so `one\ntwo` stays together
 * while `one\n\ntwo` does not. Whitespace-only input yields no paragraphs at all.
 */
function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/**
 * Fixed-size windows over one oversized paragraph, `size - overlap` apart.
 *
 * The last window can be shorter than the others and can be entirely contained in the
 * previous one; that is deliberate, because trimming it would drop the document's tail.
 */
function hardSplit(points: readonly string[], size: number, overlap: number): string[] {
  const stride = size - overlap;
  const windows: string[] = [];

  for (let start = 0; start < points.length; start += stride) {
    windows.push(points.slice(start, start + size).join(""));
    // A window that already reaches the end is the last one. Without this the loop would
    // emit a final window made only of the previous one's overlap.
    if (start + size >= points.length) break;
  }

  return windows;
}

/**
 * The last `wanted` code points of `text`, starting after a word break when one is in range.
 *
 * Cutting exactly at the window edge can begin a chunk mid-word ("…the total is fo" /
 * "urty-two"). Looking for the first space inside the tail and starting after it costs a
 * few characters of overlap and keeps the seam readable. When the tail has no space — one
 * long token, or a script that does not break on spaces — the hard cut stands: losing the
 * overlap entirely would be worse than a seam in the middle of a word.
 */
function overlapTail(text: string, wanted: number): string {
  if (wanted <= 0) return "";

  const points = Array.from(text);
  const tail = points.slice(Math.max(0, points.length - wanted));
  const space = tail.findIndex((character) => /\s/.test(character));
  if (space === -1) return tail.join("");

  const trimmed = tail
    .slice(space + 1)
    .join("")
    .trim();
  // A tail that is nothing but whitespace is no overlap at all; an empty seed would
  // otherwise produce a chunk that starts with a paragraph break.
  return trimmed;
}

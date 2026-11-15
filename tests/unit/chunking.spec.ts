import { describe, expect, it } from "vitest";
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkText } from "../../src/main/knowledge/chunking.js";

/**
 * The chunker, on its own.
 *
 * Every case here is a property of the split rather than of the app: how a paragraph break
 * is chosen, what happens to a paragraph bigger than one window, whether a chunk can end in
 * half of an emoji. None of it needs a provider, a disk or a database, which is the point —
 * a retrieval defect that turns out to be a chunking defect can be found here in
 * milliseconds instead of by staring at search results.
 */

const points = (text: string): number => Array.from(text).length;

/** A paragraph of `count` characters with no whitespace, so nothing can be word-trimmed. */
function solid(count: number, letter = "a"): string {
  return letter.repeat(count);
}

describe("a document with nothing in it", () => {
  it("is no chunks at all", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText("\n\n\n\t \n")).toEqual([]);
    // A carriage-return-only file is a Windows empty document, not one chunk of noise.
    expect(chunkText("\r\n \r\n")).toEqual([]);
  });
});

describe("text that fits", () => {
  it("stays one chunk", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    expect(chunkText("  padded  ")).toEqual(["padded"]);
  });

  it("keeps paragraphs together, separated by a blank line, while they fit", () => {
    const chunks = chunkText("first paragraph\n\nsecond paragraph\n\nthird paragraph");

    expect(chunks).toEqual(["first paragraph\n\nsecond paragraph\n\nthird paragraph"]);
  });

  it("treats a single newline as a line wrap, not a paragraph break", () => {
    // Prose wraps. Splitting on every newline would cut sentences in half on a hard-wrapped
    // file and produce chunks that start mid-thought.
    expect(chunkText("one line\ntwo lines")).toEqual(["one line\ntwo lines"]);
  });

  it("normalises CRLF so a Windows file splits on the same boundaries", () => {
    const windows = chunkText("first\r\n\r\nsecond");
    const unix = chunkText("first\n\nsecond");

    expect(windows).toEqual(unix);
  });

  it("keeps a chunk of exactly the window size as one chunk", () => {
    const text = solid(CHUNK_SIZE);
    expect(chunkText(text)).toEqual([text]);
  });
});

describe("paragraph boundaries", () => {
  it("starts a new chunk when the next paragraph would overflow", () => {
    // Two 60-character paragraphs against a 100-character window: together they are 122,
    // so they cannot share a chunk. The overlap means the second chunk repeats a slice of
    // the first one.
    const first = solid(60, "a");
    const second = solid(60, "b");

    const chunks = chunkText(`${first}\n\n${second}`, { size: 100, overlap: 20 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    // The tail of the first paragraph is carried into the second chunk, so a sentence that
    // straddled the boundary is retrievable from either side.
    expect(chunks[1]).toBe(`${first.slice(-20)}\n\n${second}`);
    expect(points(chunks[1] ?? "")).toBeLessThanOrEqual(100);
  });

  it("trims the overlap to whatever room is left, rather than overflowing", () => {
    // 95 characters of paragraph against a 100-character window leaves 3 characters for the
    // seed plus the paragraph break, which cannot hold a 20-character overlap. The seed is
    // trimmed to the 3 that fit instead of being dropped or allowed to overflow.
    const first = solid(60, "a");
    const second = solid(95, "b");

    const chunks = chunkText(`${first}\n\n${second}`, { size: 100, overlap: 20 });

    expect(chunks[1]).toBe(`aaa\n\n${second}`);
    for (const chunk of chunks) expect(points(chunk)).toBeLessThanOrEqual(100);
  });

  it("starts the overlap after a word break when there is one", () => {
    const first = "alpha beta gamma delta";
    const second = solid(15, "z");

    // Window 27 fits either paragraph alone but not both plus the paragraph break, so the
    // second chunk is seeded from the first. The last 6 characters of the first paragraph
    // are " delta"; the seed starts after the space, so the overlap begins on a word rather
    // than in the middle of one.
    const chunks = chunkText(`${first}\n\n${second}`, { size: 27, overlap: 6 });

    expect(chunks).toEqual([first, `delta\n\n${second}`]);
  });

  it("splits a paragraph larger than the window by character", () => {
    const text = solid(250, "q");

    const chunks = chunkText(text, { size: 100, overlap: 20 });

    // Stride 80 over 250 characters: [0,100), [80,180), [160,250).
    expect(chunks).toEqual([solid(100, "q"), solid(100, "q"), solid(90, "q")]);
    for (const chunk of chunks) expect(points(chunk)).toBeLessThanOrEqual(100);
  });
});

describe("a single huge paragraph", () => {
  it("covers the whole document with overlapping windows, none over the window size", () => {
    // 5 000 code points of a repeating alphabet at the defaults: seven windows, and each one
    // repeats the last 120 characters of the one before it.
    const alphabet = "0123456789";
    const text = alphabet.repeat(500);

    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(points(chunk)).toBeLessThanOrEqual(CHUNK_SIZE);
      expect(chunk.length).toBeGreaterThan(0);
    }

    // The overlap is real: each window after the first begins with the previous window's
    // last CHUNK_OVERLAP characters.
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1] ?? "";
      const current = chunks[index] ?? "";
      expect(current.startsWith(previous.slice(-CHUNK_OVERLAP))).toBe(true);
    }

    // Nothing was dropped: the last chunk ends where the document ends.
    expect(chunks.at(-1)).toBe(text.slice(-points(chunks.at(-1) ?? "")));
    // And the first begins where the document begins.
    expect(chunks[0]).toBe(text.slice(0, CHUNK_SIZE));
  });

  it("clamps an overlap that would make the stride zero, instead of looping forever", () => {
    const text = solid(300, "w");

    const chunks = chunkText(text, { size: 50, overlap: 50 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(points(chunk)).toBeLessThanOrEqual(50);
  });
});

describe("unicode", () => {
  it("never splits a surrogate pair", () => {
    // 400 code points, each two UTF-16 units: a boundary computed on `text.length` would
    // land mid-emoji and produce two replacement halves.
    const text = "🙂".repeat(400);

    const chunks = chunkText(text, { size: 100, overlap: 10 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).not.toContain("\uFFFD");
      // Every chunk is a whole number of emoji, which is only true if the cut respected
      // code points.
      expect(Array.from(chunk).every((character) => character === "🙂")).toBe(true);
      expect(points(chunk)).toBeLessThanOrEqual(100);
    }
  });

  it("keeps combining marks with the sequence they belong to when the cut allows", () => {
    // "é" as e + combining acute. A cut between the two would render a bare "e" at the end
    // of one chunk; at these sizes the whole sequence lands in one window.
    const text = "e\u0301".repeat(20);

    const chunks = chunkText(text, { size: 100, overlap: 10 });

    expect(chunks).toEqual([text]);
  });
});

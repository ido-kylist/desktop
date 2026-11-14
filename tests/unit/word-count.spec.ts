import { describe, expect, it } from "vitest";
import {
  countWords,
  WordCountRequestSchema,
  WordCountResponseSchema,
} from "../../src/shared/ipc-contract";

/**
 * The D0.5 rehearsal counting function. Words are runs of non-whitespace and
 * `characters` is the raw string length, so the cases that matter are the edges:
 * nothing, one token, ragged whitespace, non-ASCII and a payload big enough to
 * expose an accidental quadratic or an off-by-one.
 */
describe("countWords", () => {
  it("counts an empty string as nothing", () => {
    expect(countWords("")).toEqual({ words: 0, characters: 0 });
  });

  it("counts a single word", () => {
    expect(countWords("hello")).toEqual({ words: 1, characters: 5 });
  });

  it("treats runs of whitespace as separators, never as words", () => {
    // Spaces, a tab, a blank line, and leading/trailing padding.
    expect(countWords("  one\ttwo\n\nthree   ")).toEqual({ words: 3, characters: 19 });
  });

  it("counts whitespace-only input as zero words", () => {
    expect(countWords(" \t\n ")).toEqual({ words: 0, characters: 4 });
  });

  it("counts Unicode words without splitting them", () => {
    expect(countWords("héllo wörld 世界")).toEqual({ words: 3, characters: 14 });
  });

  it("reports UTF-16 code units, because characters is text.length", () => {
    // The wave emoji is a surrogate pair, so it adds two to characters.
    expect(countWords("hi 👋")).toEqual({ words: 2, characters: 5 });
  });

  it("counts a very long multi-word input without truncating", () => {
    const tokens = Array.from({ length: 10_000 }, (_, index) => `w${index}`);
    const text = tokens.join(" ");

    const counted = countWords(text);

    expect(counted.words).toBe(10_000);
    expect(counted.characters).toBe(text.length);
  });

  it("counts a single very long token as one word", () => {
    const text = "a".repeat(1_000_000);

    expect(countWords(text)).toEqual({ words: 1, characters: 1_000_000 });
  });
});

describe("scratch.wordCount contract", () => {
  it("accepts a { text } payload", () => {
    expect(WordCountRequestSchema.safeParse({ text: "ok" }).success).toBe(true);
  });

  it("rejects everything else, so the dispatcher answers BAD_REQUEST", () => {
    expect(WordCountRequestSchema.safeParse({ text: 42 }).success).toBe(false);
    expect(WordCountRequestSchema.safeParse({}).success).toBe(false);
    expect(WordCountRequestSchema.safeParse(null).success).toBe(false);
  });

  it("countWords output satisfies the declared response schema", () => {
    expect(WordCountResponseSchema.safeParse(countWords("a b c")).success).toBe(true);
  });
});

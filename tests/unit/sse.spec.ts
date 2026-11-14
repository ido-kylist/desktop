import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSse, type SseFrame } from "../../src/main/api/sse";
import { AppError } from "../../src/main/errors";

/**
 * Coverage map for the brief's numbered requirements:
 *
 *   1. blank-line frames, multi-line data ................ "data frames"
 *   2. comment lines ..................................... "comment lines"
 *   3. LF and CRLF separators, split across chunks ....... "line endings and separators"
 *   4. frames split at arbitrary byte positions ........... "chunk boundaries and UTF-8"
 *   5. event: and id: surfaced ............................ "event and id"
 *   6. data: [DONE] yielded, not thrown ................... "the [DONE] sentinel"
 *   7. EOF mid-frame throws UPSTREAM_TRUNCATED ........... "end of input mid-frame"
 *   8. several frames in one chunk ....................... "several frames per chunk"
 *   9. empty stream ...................................... "empty input"
 *
 * Plus what the brief calls "a malformed frame": content the parser cannot
 * understand is surfaced verbatim, never thrown.
 */

const encoder = new TextEncoder();

async function* asStream(
  chunks: Iterable<Uint8Array | string>,
): AsyncGenerator<Uint8Array | string> {
  for (const chunk of chunks) yield chunk;
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSse(stream)) frames.push(frame);
  return frames;
}

interface Truncated {
  frames: SseFrame[];
  error: AppError;
}

/** Collects the frames delivered before the parser throws, plus the AppError it threw. */
async function collectUntilError(stream: AsyncIterable<Uint8Array | string>): Promise<Truncated> {
  const frames: SseFrame[] = [];
  try {
    for await (const frame of parseSse(stream)) frames.push(frame);
  } catch (error) {
    if (error instanceof AppError) return { frames, error };
    throw error;
  }
  throw new Error("expected parseSse to throw, but the stream ended cleanly");
}

describe("parseSse", () => {
  describe("data frames", () => {
    it("yields one frame per blank-line-separated data payload", async () => {
      const frames = await collect(asStream(["data: a\n\ndata: b\n\n"]));

      expect(frames).toEqual([{ data: "a" }, { data: "b" }]);
    });

    it("joins multi-line data fields with a newline", async () => {
      const frames = await collect(asStream(["data: first\ndata: second\ndata: third\n\n"]));

      expect(frames).toEqual([{ data: "first\nsecond\nthird" }]);
    });

    it("keeps a JSON body split across data lines intact", async () => {
      const frames = await collect(asStream(['data: {"city":\ndata: "Lisbon"}\n\n']));

      expect(frames).toEqual([{ data: '{"city":\n"Lisbon"}' }]);
    });

    it("strips exactly one space after the colon and preserves the rest", async () => {
      const frames = await collect(asStream(["data:no-space\n\ndata:  two-spaces\n\n"]));

      expect(frames).toEqual([{ data: "no-space" }, { data: " two-spaces" }]);
    });

    it("treats a bare data field as an empty data line", async () => {
      const frames = await collect(asStream(["data\n\n"]));

      expect(frames).toEqual([{ data: "" }]);
    });
  });

  describe("comment lines", () => {
    it("emits no frame for a comment and keeps parsing after it", async () => {
      const frames = await collect(asStream([": keep-alive\n\ndata: x\n\n"]));

      expect(frames).toEqual([{ data: "x" }]);
    });

    it("ignores a comment inside a frame without disturbing the data", async () => {
      const frames = await collect(asStream(["data: a\n: a note\n\n"]));

      expect(frames).toEqual([{ data: "a" }]);
    });

    it("does not count a terminated comment as an unfinished frame at end of input", async () => {
      const frames = await collect(asStream([": keep-alive\n"]));

      expect(frames).toEqual([]);
    });
  });

  describe("line endings and separators", () => {
    it("accepts CRLF frame separators", async () => {
      const frames = await collect(asStream(["data: a\r\n\r\ndata: b\r\n\r\n"]));

      expect(frames).toEqual([{ data: "a" }, { data: "b" }]);
    });

    it("accepts a CRLF separator split across two chunks", async () => {
      const frames = await collect(asStream(["data: a\r\n\r", "\ndata: b\r\n\r\n"]));

      expect(frames).toEqual([{ data: "a" }, { data: "b" }]);
    });

    it("accepts an LF separator split across two chunks", async () => {
      const frames = await collect(asStream(["data: a\n", "\ndata: b\n\n"]));

      expect(frames).toEqual([{ data: "a" }, { data: "b" }]);
    });

    it("accepts CRLF line endings inside a multi-line frame", async () => {
      const frames = await collect(asStream(["data: a\r\ndata: b\r\n\r\n"]));

      expect(frames).toEqual([{ data: "a\nb" }]);
    });

    it("accepts a lone CR as a line terminator", async () => {
      const frames = await collect(asStream(["data: a\r\rdata: b\r\r"]));

      expect(frames).toEqual([{ data: "a" }, { data: "b" }]);
    });

    it("accepts a lone CR separator split across two chunks", async () => {
      const frames = await collect(asStream(["data: a\r", "\rdata: b\r\r"]));

      expect(frames).toEqual([{ data: "a" }, { data: "b" }]);
    });
  });

  describe("chunk boundaries and UTF-8", () => {
    it("decodes a multi-byte character split across chunks", async () => {
      const source = "data: héllo — 世界 🚀\n\n";
      const bytes = encoder.encode(source);

      const frames = await collect(asStream(Array.from(bytes, (byte) => Uint8Array.of(byte))));

      expect(frames).toEqual([{ data: "héllo — 世界 🚀" }]);
    });

    it("yields identical frames for a split at any single byte position", async () => {
      const source = "event: delta\ndata: héllo 🚀\ndata: second\n\ndata: [DONE]\n\n";
      const bytes = encoder.encode(source);
      const expected = await collect(asStream([source]));

      expect(expected).toHaveLength(2);
      for (let split = 1; split < bytes.length; split += 1) {
        const frames = await collect(asStream([bytes.slice(0, split), bytes.slice(split)]));
        expect(frames).toEqual(expected);
      }
    });
  });

  describe("event and id", () => {
    it("surfaces event and id on the frame", async () => {
      const frames = await collect(asStream(["event: delta\nid: 42\ndata: hi\n\n"]));

      expect(frames).toEqual([{ data: "hi", event: "delta", id: "42" }]);
    });

    it("clears event and id for the following frame", async () => {
      const frames = await collect(asStream(["event: delta\nid: 7\ndata: one\n\ndata: two\n\n"]));

      expect(frames).toEqual([{ data: "one", event: "delta", id: "7" }, { data: "two" }]);
    });

    it("omits event and id entirely when the frame does not carry them", async () => {
      const frames = await collect(asStream(["data: plain\n\n"]));
      const frame = frames[0];

      expect(frame?.data).toBe("plain");
      expect(Object.keys(frame ?? {})).toEqual(["data"]);
    });
  });

  describe("the [DONE] sentinel", () => {
    it("yields data: [DONE] as an ordinary frame", async () => {
      const frames = await collect(asStream(["data: [DONE]\n\n"]));

      expect(frames).toEqual([{ data: "[DONE]" }]);
    });

    it("keeps parsing after [DONE], leaving the stop decision to the caller", async () => {
      const frames = await collect(asStream(["data: [DONE]\n\ndata: after\n\n"]));

      expect(frames).toEqual([{ data: "[DONE]" }, { data: "after" }]);
    });
  });

  describe("end of input mid-frame", () => {
    it("throws UPSTREAM_TRUNCATED for an unterminated line, after delivering complete frames", async () => {
      const { frames, error } = await collectUntilError(
        asStream(["data: complete\n\ndata: partial"]),
      );

      expect(frames).toEqual([{ data: "complete" }]);
      expect(error.code).toBe("UPSTREAM_TRUNCATED");
      expect(error.message).toBe("SSE stream ended mid-frame");
    });

    it("throws UPSTREAM_TRUNCATED for a terminated data line with no closing blank line", async () => {
      const { frames, error } = await collectUntilError(asStream(["data: hi\n"]));

      expect(frames).toEqual([]);
      expect(error.code).toBe("UPSTREAM_TRUNCATED");
    });

    it("throws rather than dropping bytes when input stops mid-codepoint", async () => {
      const complete = encoder.encode("data: a\n\n");
      const partialCodepoint = encoder.encode("🚀").slice(0, 2);

      const { frames, error } = await collectUntilError(asStream([complete, partialCodepoint]));

      expect(frames).toEqual([{ data: "a" }]);
      expect(error.code).toBe("UPSTREAM_TRUNCATED");
    });
  });

  describe("several frames per chunk", () => {
    it("yields every frame contained in one chunk", async () => {
      const frames = await collect(asStream(["data: one\n\ndata: two\n\ndata: three\n\n"]));

      expect(frames).toEqual([{ data: "one" }, { data: "two" }, { data: "three" }]);
    });
  });

  describe("empty input", () => {
    it("ends cleanly with no frames", async () => {
      expect(await collect(asStream([]))).toEqual([]);
    });

    it("ends cleanly for empty chunks", async () => {
      expect(await collect(asStream(["", new Uint8Array(0)]))).toEqual([]);
    });
  });

  describe("content the parser does not interpret", () => {
    it("surfaces a non-JSON payload verbatim instead of throwing", async () => {
      const frames = await collect(asStream(["data: {not json\n\n"]));

      expect(frames).toEqual([{ data: "{not json" }]);
    });

    it("ignores unknown fields such as retry", async () => {
      const frames = await collect(asStream(["retry: 3000\ndata: x\n\n"]));

      expect(frames).toEqual([{ data: "x" }]);
    });

    it("does not count an unknown field as an unfinished frame at end of input", async () => {
      expect(await collect(asStream(["retry: 3000\n"]))).toEqual([]);
    });
  });
});

describe("parseSse against the mock server's fixtures", () => {
  const fixturePath = (name: string) =>
    fileURLToPath(new URL(`../../mock/fixtures/${name}`, import.meta.url));

  /**
   * The fixture files are the mock server's *input*, not its output. Its
   * `streamFixture` splits a file on blank lines, trims each block, and re-emits
   * every block terminated by "\n\n" — so a client only ever sees the re-framed
   * form. Tests must consume that form, not the file's bytes.
   */
  function wireForm(raw: string): string {
    return raw
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block !== "")
      .map((block) => `${block}\n\n`)
      .join("");
  }

  interface Chunk {
    choices?: { delta?: { content?: string } }[];
  }

  function contentOf(frames: SseFrame[]): string {
    return frames
      .map((frame) => {
        if (frame.data === "[DONE]") return "";
        const chunk = JSON.parse(frame.data) as Chunk;
        return chunk.choices?.[0]?.delta?.content ?? "";
      })
      .join("");
  }

  it("parses text.sse into its deltas plus [DONE]", async () => {
    const raw = await readFile(fixturePath("text.sse"), "utf8");

    const frames = await collect(asStream([wireForm(raw)]));

    expect(frames).toHaveLength(7);
    expect(frames.at(-1)).toEqual({ data: "[DONE]" });
    expect(contentOf(frames)).toBe("Hello from the mock.");
  });

  it("parses text.sse identically when the transport splits it at odd offsets", async () => {
    const wire = wireForm(await readFile(fixturePath("text.sse"), "utf8"));
    const bytes = encoder.encode(wire);
    const expected = await collect(asStream([wire]));

    const chunks: Uint8Array[] = [];
    for (let start = 0; start < bytes.length; start += 7) {
      chunks.push(bytes.slice(start, start + 7));
    }

    expect(await collect(asStream(chunks))).toEqual(expected);
  });

  it("rejects a fixture taken raw, because its last frame is never closed", async () => {
    // text.sse ends "data: [DONE]\n" with no blank line. Re-framing by the server
    // is what makes it parseable, and this is the proof that the parser does not
    // quietly accept an unterminated tail.
    const raw = await readFile(fixturePath("text.sse"), "utf8");

    const { frames, error } = await collectUntilError(asStream([raw]));

    expect(frames).toHaveLength(6);
    expect(error.code).toBe("UPSTREAM_TRUNCATED");
  });

  it("parses truncated.sse as complete frames, because the framing is not what was cut", async () => {
    const wire = wireForm(await readFile(fixturePath("truncated.sse"), "utf8"));

    const frames = await collect(asStream([wire]));

    expect(frames).toHaveLength(2);
    expect(frames.some((frame) => frame.data === "[DONE]")).toBe(false);
    expect(contentOf(frames)).toBe("This stream stops mid-");
  });
});

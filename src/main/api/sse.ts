import { AppError } from "../errors.js";

/**
 * Server-Sent Events framing, over whatever bytes the transport hands us.
 *
 * The parser's only job is framing. It does not parse JSON, it does not interpret
 * `[DONE]`, and it does not decide what a truncated stream means for the UI — the
 * caller does (D1b). What it does guarantee:
 *
 *  - a frame is only emitted on a blank line, with multi-line `data:` joined by
 *    "\n", so a JSON body split across `data:` lines arrives intact;
 *  - comment lines (`:` …, the keep-alive) never produce a frame and never count
 *    as an unfinished one;
 *  - `\n` and `\r\n` both terminate a line, including a `\r\n` split across two
 *    chunks, so the framing does not depend on how the transport chunks the body;
 *  - UTF-8 is decoded with a streaming decoder, so a multi-byte character split
 *    across chunks is not mangled into replacement characters;
 *  - end of input in the middle of a frame raises `UPSTREAM_TRUNCATED` instead of
 *    dropping the partial frame, because a silent drop at this layer looks like a
 *    finished answer one layer up.
 */

export interface SseFrame {
  data: string;
  event?: string;
  id?: string;
}

interface LineBreak {
  /** Index of the line terminator's first character. */
  end: number;
  /** 1 for `\n` or a lone `\r`, 2 for `\r\n`. */
  width: number;
}

/**
 * The first line terminator in `input`, or null when no complete line is in the
 * buffer yet. A trailing `\r` is held back: it may be the first half of a `\r\n`
 * that arrives in the next chunk. At end of input that ambiguity is resolved the
 * other way, so a lone `\r` still terminates.
 */
function findLineBreak(input: string, atEof: boolean): LineBreak | null {
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === "\n") return { end: i, width: 1 };
    if (char === "\r") {
      const next = input[i + 1];
      if (next === undefined && !atEof) return null;
      return { end: i, width: next === "\n" ? 2 : 1 };
    }
  }
  return null;
}

/**
 * The incremental half of the parser, kept separate from the generator so that
 * end-of-input is handled in exactly one place instead of once per `yield`.
 */
class SseFramer {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private dataLines: string[] = [];
  private event: string | undefined;
  private id: string | undefined;
  /** Whether a field has been seen since the last blank line. */
  private inFrame = false;

  push(chunk: Uint8Array | string): SseFrame[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** Flushes the decoder, drains what the last chunk completed, then checks for a frame that never ended. */
  end(): SseFrame[] {
    // Emits U+FFFD if the input stopped mid-codepoint. That is a broken stream,
    // and the leftover below is what reports it.
    this.buffer += this.decoder.decode();

    const frames = this.drain(true);
    if (this.buffer !== "" || this.inFrame) {
      throw new AppError("UPSTREAM_TRUNCATED", "SSE stream ended mid-frame", {
        details: { bufferedChars: this.buffer.length, pendingDataLines: this.dataLines.length },
      });
    }
    return frames;
  }

  private drain(atEof: boolean): SseFrame[] {
    const frames: SseFrame[] = [];

    for (;;) {
      const lineBreak = findLineBreak(this.buffer, atEof);
      if (lineBreak === null) return frames;

      const line = this.buffer.slice(0, lineBreak.end);
      this.buffer = this.buffer.slice(lineBreak.end + lineBreak.width);

      const frame = this.applyLine(line);
      if (frame !== null) frames.push(frame);
    }
  }

  /** Applies one field line, returning a frame when the line closes one. */
  private applyLine(line: string): SseFrame | null {
    if (line === "") {
      const frame =
        this.dataLines.length > 0
          ? {
              data: this.dataLines.join("\n"),
              ...(this.event === undefined ? {} : { event: this.event }),
              ...(this.id === undefined ? {} : { id: this.id }),
            }
          : null;

      // `event` and `id` are per-frame here. Both clear with the frame, and a
      // blank line with no data closes nothing and emits nothing.
      this.dataLines = [];
      this.event = undefined;
      this.id = undefined;
      this.inFrame = false;
      return frame;
    }

    // `: keep-alive` and friends. Ignored, and not a frame in progress.
    if (line.startsWith(":")) return null;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Exactly one leading space is part of the field syntax; anything beyond it
    // is payload.
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") {
      this.dataLines.push(value);
      this.inFrame = true;
    } else if (field === "event") {
      this.event = value;
      this.inFrame = true;
    } else if (field === "id") {
      this.id = value;
      this.inFrame = true;
    }
    // Every other field (`retry:`, vendor extensions) is ignored, per the spec.

    return null;
  }
}

/**
 * Yields one frame per `data:` payload as the stream delivers it. `data: [DONE]`
 * is yielded like any other frame — stopping there is the caller's decision, not
 * a fact about the framing.
 */
export async function* parseSse(
  stream: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<SseFrame> {
  const framer = new SseFramer();

  for await (const chunk of stream) {
    for (const frame of framer.push(chunk)) yield frame;
  }

  for (const frame of framer.end()) yield frame;
}

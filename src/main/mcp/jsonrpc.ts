/**
 * JSON-RPC 2.0 over newline-delimited lines — MCP's stdio framing.
 *
 * One JSON object per line, each way, for the life of the child process. There is no
 * length prefix and no SSE: a message ends at `\n`, and a server that writes two messages
 * in one chunk, or one message across three, is speaking the same protocol as one that
 * writes them one at a time.
 *
 * The peer is deliberately transport-agnostic: it is handed a `send` sink and fed bytes
 * with `receive`, so the framing rules are testable without a child process, and a broken
 * server cannot take the app down with it. Nothing in here throws out of a stream handler:
 * a malformed line is reported to `onMalformed` and the peer keeps going, because the
 * alternative is an unhandled `error` event killing the main process over one bad byte.
 */

/** A JSON-RPC error object, as the wire carries it. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

/** A request that got no answer in time. Distinct from a transport failure and from a
 * JSON-RPC error, because "it never answered" and "it said no" are different facts. */
export class JsonRpcTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`${method} did not answer within ${timeoutMs} ms`);
    this.name = "JsonRpcTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Turns a byte stream into whole lines.
 *
 * `push` returns the lines that are complete; the trailing fragment is held until the
 * rest of it arrives. `flush` hands back whatever is left, so a stream that died
 * mid-message surfaces as a truncated line rather than vanishing silently.
 */
export class LineDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (!this.buffer.includes("\n")) return [];

    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    return parts.map(withoutCarriageReturn);
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() === "" ? [] : [withoutCarriageReturn(rest)];
  }
}

/** Tolerates CRLF: a server written on Windows is still speaking the same protocol. */
function withoutCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export interface JsonRpcPeerOptions {
  /** Writes one whole line, terminator included. Called for every outbound message. */
  send: (line: string) => void;
  /** Default per-request deadline. */
  timeoutMs?: number;
  /** A line that was not a JSON object. Reported, never thrown. */
  onMalformed?: (line: string, cause: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class JsonRpcPeer {
  private readonly send: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly onMalformed: ((line: string, cause: unknown) => void) | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new LineDecoder();
  private nextId = 1;
  private closed: Error | null = null;

  constructor(options: JsonRpcPeerOptions) {
    this.send = options.send;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onMalformed = options.onMalformed;
  }

  /** How many requests are waiting. Used by the manager's shutdown path and by tests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  /**
   * Sends a request and resolves with its `result`.
   *
   * Rejects with `JsonRpcTimeoutError` if the deadline passes, `JsonRpcError` if the peer
   * answered with an error object, and the close reason if the transport died first. The
   * pending entry is removed on every one of those paths, so a late answer is dropped
   * rather than delivered to a promise nobody is holding.
   */
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed !== null) return Promise.reject(this.closed);

    const id = this.nextId;
    this.nextId += 1;
    const deadline = timeoutMs ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcTimeoutError(method, deadline));
      }, deadline);
      // A pending request must never be the reason the process stays alive at quit.
      timer.unref();

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
      if (params !== undefined) message.params = params;

      try {
        this.send(JSON.stringify(message));
      } catch (error) {
        // A dead stdin is a transport failure, not a protocol error: settle now rather
        // than waiting out a deadline nobody will meet.
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** A notification: no id, no answer, and no promise to break. */
  notify(method: string, params?: unknown): void {
    if (this.closed !== null) return;
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    try {
      this.send(JSON.stringify(message));
    } catch {
      // Notifications are advisory (`notifications/initialized` above all): a failed write
      // is already reported by the request path, and there is nothing to reject here.
    }
  }

  /** Feeds inbound bytes. Safe to call after `close`; the tail is simply discarded. */
  receive(chunk: string): void {
    for (const line of this.decoder.push(chunk)) this.dispatch(line);
  }

  /**
   * Ends the transport and rejects everything outstanding with `reason`.
   *
   * The decoder is flushed first: a final message written without its trailing newline is
   * a complete message, and delivering it is better than reporting a spurious crash.
   */
  close(reason: Error): void {
    if (this.closed !== null) return;
    this.closed = reason;

    for (const line of this.decoder.flush()) this.dispatch(line);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this.pending.delete(id);
    }
  }

  private dispatch(line: string): void {
    if (line.trim() === "") return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (cause) {
      this.onMalformed?.(line, cause);
      return;
    }

    if (typeof message !== "object" || message === null) {
      this.onMalformed?.(line, new Error("a JSON-RPC message must be an object"));
      return;
    }

    const record = message as Record<string, unknown>;
    const id = record.id;

    // A message with a `method` is a request or a notification, never a response — even
    // when its id happens to collide with one of ours.
    if (typeof record.method === "string") {
      if (id !== undefined && id !== null) {
        // A request *from* the server. This client advertises no capabilities, so there is
        // nothing it could answer; refusing — with the id it asked under — is better than
        // leaving the server waiting on a reply that will never come.
        this.refuse(record.method, id);
      }
      // Otherwise a notification — `notifications/message`,
      // `notifications/tools/list_changed` — and this phase subscribes to none of them.
      return;
    }

    if (typeof id === "number") {
      const entry = this.pending.get(id);
      if (entry === undefined) return; // A duplicate or late answer to nothing we asked.
      this.pending.delete(id);
      clearTimeout(entry.timer);

      const error = record.error;
      if (error !== undefined && error !== null) {
        entry.reject(toJsonRpcError(error));
        return;
      }
      entry.resolve(record.result);
    }
  }

  private refuse(method: string, id: unknown): void {
    const message = {
      jsonrpc: "2.0",
      // Echoed, because a response the server cannot match to its request is a reply it
      // will keep waiting on: -32601 with the wrong id is the same as silence.
      id,
      error: { code: -32601, message: `Method not supported by this client: ${method}` },
    };
    try {
      this.send(JSON.stringify(message));
    } catch {
      // The transport is already gone; the close path is what reports that.
    }
  }
}

function toJsonRpcError(error: unknown): JsonRpcError {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "number" ? record.code : -32_603;
    const message =
      typeof record.message === "string" ? record.message : "the server reported an error";
    return new JsonRpcError(code, message, record.data);
  }
  return new JsonRpcError(-32_603, "the server reported an error");
}

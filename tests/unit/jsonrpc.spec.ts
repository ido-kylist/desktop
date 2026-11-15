import { describe, expect, it } from "vitest";
import {
  JsonRpcError,
  JsonRpcPeer,
  JsonRpcTimeoutError,
  LineDecoder,
} from "../../src/main/mcp/jsonrpc.js";

/**
 * The framing rules, in isolation.
 *
 * Every claim here is about MCP's stdio transport as it actually behaves: a message is a
 * line, a line can arrive in pieces, two lines can arrive in one read, and a server can
 * write something that is not JSON at all. None of those may throw out of a stream
 * handler — an unhandled error event on a child's stdout kills the main process, which is
 * the failure the whole D7 slice is written to avoid.
 *
 * The peer is driven directly (`receive`) rather than through a child, so each rule is
 * tested for its own sake and not through the accident of how a process chunked its
 * writes.
 */

interface Harness {
  peer: JsonRpcPeer;
  /** Every line the peer handed to its sink, in order. */
  outbound: string[];
  /** Every line the peer could not parse, in order. */
  malformed: string[];
}

function harness(options: { timeoutMs?: number } = {}): Harness {
  const outbound: string[] = [];
  const malformed: string[] = [];
  const peer = new JsonRpcPeer({
    send: (line) => outbound.push(line),
    timeoutMs: options.timeoutMs ?? 2_000,
    onMalformed: (line) => malformed.push(line),
  });
  return { peer, outbound, malformed };
}

interface SentMessage {
  jsonrpc: string;
  id: number;
  method: string;
  params?: unknown;
}

/** What the peer last wrote, parsed. Throws rather than returning undefined. */
function lastSent(outbound: readonly string[]): SentMessage {
  const line = outbound.at(-1);
  if (line === undefined) throw new Error("the peer sent nothing");
  return JSON.parse(line) as SentMessage;
}

/** Every request the peer wrote, in order. */
function sentRequests(outbound: readonly string[]): SentMessage[] {
  return outbound.map((line) => JSON.parse(line) as SentMessage);
}

/** A response line, exactly as a server would write it. */
function response(id: number, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

function rpcError(id: number, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`;
}

describe("LineDecoder", () => {
  it("returns nothing until a line is complete", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a"')).toEqual([]);
    expect(decoder.push(":1}")).toEqual([]);
    expect(decoder.push("\n")).toEqual(['{"a":1}']);
  });

  it("returns every complete line when several arrive in one chunk", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(decoder.push(":3}\n")).toEqual(['{"c":3}']);
  });

  it("tolerates CRLF, because a server on Windows speaks the same protocol", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it("hands back a trailing fragment on flush, and nothing when it is blank", () => {
    const decoder = new LineDecoder();
    decoder.push('{"a":1}');
    expect(decoder.flush()).toEqual(['{"a":1}']);

    const blank = new LineDecoder();
    blank.push("  \n");
    expect(blank.flush()).toEqual([]);
  });
});

describe("JsonRpcPeer framing", () => {
  it("correlates two requests whose answers arrive out of order", async () => {
    const { peer, outbound } = harness();

    const first = peer.request<{ which: string }>("one", {});
    const second = peer.request<{ which: string }>("two", {});
    expect(peer.pendingCount).toBe(2);

    const [firstSent, secondSent] = sentRequests(outbound);
    expect(firstSent?.id).not.toBe(secondSent?.id);

    // The second answer first. Each promise gets its own result, not whichever came first.
    peer.receive(response(secondSent?.id ?? 0, { which: "second" }));
    peer.receive(response(firstSent?.id ?? 0, { which: "first" }));

    await expect(first).resolves.toEqual({ which: "first" });
    await expect(second).resolves.toEqual({ which: "second" });
    expect(peer.pendingCount).toBe(0);
  });

  it("reassembles one message split across chunks, at every possible offset", async () => {
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { split: true } })}\n`;

    for (let cut = 1; cut < line.length; cut += 1) {
      const { peer } = harness();
      const pending = peer.request("ping", {});

      peer.receive(line.slice(0, cut));
      // Still waiting: a fragment is not a message, and nothing may resolve early.
      expect(peer.pendingCount).toBe(1);

      peer.receive(line.slice(cut));
      await expect(pending).resolves.toEqual({ split: true });
      expect(peer.pendingCount).toBe(0);
      peer.close(new Error("closed by the test"));
    }
  });

  it("dispatches several messages that arrive in a single chunk", async () => {
    const { peer, outbound } = harness();
    const first = peer.request("one", {});
    const second = peer.request("two", {});
    const [firstSent, secondSent] = sentRequests(outbound);

    // One write, two messages: the read side must not lose the second one.
    peer.receive(response(firstSent?.id ?? 0, "first") + response(secondSent?.id ?? 0, "second"));

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(peer.pendingCount).toBe(0);
  });

  it("surfaces an unparseable line instead of throwing, and keeps going", async () => {
    const { peer, outbound, malformed } = harness();
    const pending = peer.request("ping", {});
    const id = lastSent(outbound).id;

    // A server that writes a greeting before it speaks JSON. This would be an unhandled
    // stream error if it were allowed to throw.
    expect(() => peer.receive("hello, I am a server\n")).not.toThrow();
    expect(malformed).toEqual(["hello, I am a server"]);

    // Not an object either. Also not fatal.
    expect(() => peer.receive("42\n")).not.toThrow();
    expect(malformed).toEqual(["hello, I am a server", "42"]);

    // And the peer still answers the request that was outstanding.
    peer.receive(response(id, { alive: true }));
    await expect(pending).resolves.toEqual({ alive: true });
  });

  it("rejects with the server's own error object, not a string", async () => {
    const { peer, outbound } = harness();
    const pending = peer.request("tools/call", {});
    const id = lastSent(outbound).id;

    peer.receive(rpcError(id, -32602, "unknown tool: nope"));

    await expect(pending).rejects.toBeInstanceOf(JsonRpcError);
    await pending.catch((error: unknown) => {
      expect((error as JsonRpcError).code).toBe(-32602);
      expect((error as JsonRpcError).message).toBe("unknown tool: nope");
    });
  });

  it("rejects a request that is not answered in time, and forgets it", async () => {
    const { peer, outbound } = harness({ timeoutMs: 20 });
    const pending = peer.request("slow", {});
    const id = lastSent(outbound).id;

    await expect(pending).rejects.toBeInstanceOf(JsonRpcTimeoutError);
    expect(peer.pendingCount).toBe(0);

    // A late answer to a request nobody is waiting for is dropped, not thrown.
    expect(() => peer.receive(response(id, "too late"))).not.toThrow();
  });

  it("delivers a final message that arrived without its newline, then rejects the rest", async () => {
    const { peer, outbound } = harness();
    const answered = peer.request("first", {});
    const orphaned = peer.request("second", {});
    const [firstSent] = sentRequests(outbound);

    // The stream died mid-write, but the message itself was complete. Flushing it is the
    // honest read; dropping it would report a spurious crash.
    peer.receive(
      `${JSON.stringify({ jsonrpc: "2.0", id: firstSent?.id ?? 0, result: "made it" })}`,
    );
    peer.close(new Error("the server exited"));

    await expect(answered).resolves.toBe("made it");
    await expect(orphaned).rejects.toThrow("the server exited");
    expect(peer.isClosed).toBe(true);
    expect(peer.pendingCount).toBe(0);
  });

  it("refuses a request initiated by the server instead of leaving it waiting", () => {
    const { peer, outbound } = harness();

    peer.receive(
      `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "sampling/createMessage", params: {} })}\n`,
    );

    // A refusal, not a result: this client advertises no capabilities, so it has nothing
    // it could answer with. The id is echoed so the server can match it to its request.
    expect(outbound.length).toBe(1);
    expect(JSON.parse(outbound[0] ?? "")).toMatchObject({
      id: 7,
      error: { code: -32601 },
    });
  });

  it("ignores notifications, which are what a server sends without an id", () => {
    const { peer, outbound, malformed } = harness();

    expect(() =>
      peer.receive(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })}\n`),
    ).not.toThrow();

    // Ignored means ignored: no answer sent, nothing reported as malformed.
    expect(outbound).toEqual([]);
    expect(malformed).toEqual([]);
    expect(peer.pendingCount).toBe(0);
  });
});

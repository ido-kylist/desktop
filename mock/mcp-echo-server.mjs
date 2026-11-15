#!/usr/bin/env node
/**
 * Mock MCP server — zero dependencies, newline-delimited JSON-RPC 2.0 over stdio.
 *
 * Exists so D7 can prove the transport, the approval gate and the crash path against a
 * real child process instead of a fake one. It is spawned exactly the way a real server
 * would be (`node mock/mcp-echo-server.mjs`, no shell), and it speaks the framing the
 * manager implements: one JSON object per line, each way.
 *
 * Two tools, one per behaviour that needs a witness:
 *
 *   echo   → answers with the arguments it was called with, as JSON text
 *   crash  → writes a line to stderr and exits the process without answering
 *
 * The `crash` tool is how the isolation claim is tested: a server dying mid-call must
 * become a `crashed` status in the panel, not an exception in the main process.
 *
 * Deliberate choices, because a mock that is nicer than a real server hides bugs:
 *  - unknown methods get -32601, not silence
 *  - unparseable lines get -32700, not a crash
 *  - a `tools/call` for an unknown tool is a JSON-RPC error, which the manager records as a
 *    `failed` approval
 */
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the arguments this tool was called with.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Any text to echo." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "crash",
    description: "Exit the server process without answering, to exercise the crash path.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

/** One JSON object per line, terminator included. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function callTool(id, params) {
  const name = params && typeof params === "object" ? params.name : undefined;
  const args = params && typeof params === "object" && params.arguments ? params.arguments : {};

  if (name === "echo") {
    // The arguments go back as text, which is what a real tool result looks like and what
    // lets the integration test prove the exact object made the round trip.
    return sendResult(id, {
      content: [{ type: "text", text: JSON.stringify(args) }],
      isError: false,
    });
  }

  if (name === "crash") {
    process.stderr.write("crash tool invoked: exiting without answering\n");
    process.exit(1);
  }

  return sendError(id, -32602, `unknown tool: ${String(name)}`);
}

function handle(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    sendError(null, -32600, "invalid request");
    return;
  }

  const { id, method, params } = message;

  // A notification has no id and gets no answer. `notifications/initialized` is the one a
  // client always sends, and answering it would be a protocol violation.
  const isNotification = id === undefined || id === null;

  if (typeof method !== "string") {
    if (!isNotification) sendError(id, -32600, "invalid request");
    return;
  }

  switch (method) {
    case "initialize":
      if (isNotification) return;
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cleon-mock-echo", version: "0.0.0" },
      });
      return;

    case "notifications/initialized":
      return;

    case "ping":
      if (!isNotification) sendResult(id, {});
      return;

    case "tools/list":
      if (isNotification) return;
      sendResult(id, { tools: TOOLS });
      return;

    case "tools/call":
      if (isNotification) return;
      callTool(id, params);
      return;

    default:
      if (!isNotification) sendError(id, -32601, `method not found: ${method}`);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

lines.on("line", (line) => {
  if (line.trim() === "") return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // Reported, not fatal: a client sending a bad line must not take the server with it.
    sendError(null, -32700, "parse error");
    return;
  }
  handle(message);
});

// A closed stdin is the client going away; there is nothing left to serve.
lines.on("close", () => process.exit(0));

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
/**
 * Mock inference server — zero dependencies.
 *
 * Exists so D1 can build the stream parser and the chat surface without a real
 * key, and so the error paths are exercised on demand instead of in production.
 *
 *   node mock/server.mjs            # 127.0.0.1:4790
 *   PORT=4791 node mock/server.mjs
 *
 * The requested model selects the scenario, so a client switches behaviour by
 * changing one string:
 *
 *   mock/text       → normal token stream, ends with finish_reason + [DONE]
 *   mock/reasoning  → reasoning_content deltas before content
 *   mock/tool       → tool_calls deltas in two argument fragments
 *   mock/truncated  → stream dies mid-sentence, no finish_reason, no [DONE]
 *   mock/402        → 402 payment required, JSON body
 *   mock/429        → 429 rate limited, JSON body with Retry-After
 *
 * `POST /v1/embeddings` (D8) answers with deterministic pseudo-vectors, so a knowledge
 * test needs no key and gets the same numbers on every run. See `embed` below for why
 * they are bag-of-token hashes rather than a hash of the whole string.
 */
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4790);
const HOST = "127.0.0.1";
/** Delay between frames, so a client cannot pass by accident on a single chunk. */
const FRAME_DELAY_MS = Number(process.env.FRAME_DELAY_MS || 25);

const SCENARIOS = {
  "mock/text": "text.sse",
  "mock/reasoning": "reasoning.sse",
  "mock/tool": "tool.sse",
  "mock/truncated": "truncated.sse",
};

const MODELS = [
  { id: "mock/text", object: "model", owned_by: "cleon-mock" },
  { id: "mock/reasoning", object: "model", owned_by: "cleon-mock" },
  { id: "mock/tool", object: "model", owned_by: "cleon-mock" },
  { id: "mock/truncated", object: "model", owned_by: "cleon-mock" },
  { id: "mock/402", object: "model", owned_by: "cleon-mock" },
  { id: "mock/429", object: "model", owned_by: "cleon-mock" },
];

function sendJson(res, code, body, headers = {}) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/* --------------------------------------------------------- D8: embeddings */

/** The vector width the mock reports. Small enough to read, wide enough to separate. */
const EMBEDDING_DIM = 64;

/**
 * A deterministic pseudo-embedding: a bag of hashed tokens, L2-normalised.
 *
 * Not a hash of the whole string, and that is the point. A per-string hash gives every text
 * an unrelated vector, so an exact-phrase query would score *randomly* against the chunks
 * that contain it — the integration test would assert a coin flip. Hashing each token into
 * a dimension means two texts that share words share direction, which is what retrieval
 * is supposed to reward; the mock then behaves like a very bad but honest embedding model
 * instead of noise.
 *
 * Deterministic for two reasons: a test that searches twice gets the same ranking, and a
 * corpus ingested once can be searched by a process that restarted.
 */
function embed(text) {
  const vector = new Float64Array(EMBEDDING_DIM);
  const tokens = String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "");

  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const dim = digest.readUInt32BE(0) % EMBEDDING_DIM;
    // A sign per token, so two tokens that collide in a dimension can cancel rather than
    // always reinforcing each other. Derived from the digest, so it is stable too.
    const sign = (digest[4] & 1) === 0 ? 1 : -1;
    vector[dim] += sign;
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return Array.from(vector);

  const length = Math.sqrt(norm);
  return Array.from(vector, (value) => value / length);
}

/** `{ model, input }` → one vector per input, in input order, with `index` set. */
function handleEmbeddings(res, body) {
  const input = body.input;
  const texts = typeof input === "string" ? [input] : Array.isArray(input) ? input : null;
  if (texts === null || texts.length === 0 || texts.some((text) => typeof text !== "string")) {
    return sendJson(res, 400, {
      error: { code: "BAD_REQUEST", message: "input must be a string or an array of strings" },
    });
  }

  const model = typeof body.model === "string" && body.model !== "" ? body.model : "mock/embed";

  return sendJson(res, 200, {
    object: "list",
    model,
    data: texts.map((text, index) => ({
      object: "embedding",
      index,
      embedding: embed(text),
    })),
    usage: {
      prompt_tokens: texts.reduce((total, text) => total + text.split(/\s+/).length, 0),
      total_tokens: texts.reduce((total, text) => total + text.split(/\s+/).length, 0),
    },
  });
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function streamFixture(res, file) {
  const raw = await readFile(join(DIR, "fixtures", file), "utf8");
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  for (const block of raw.split("\n\n")) {
    const frame = block.trim();
    if (!frame) continue;
    res.write(`${frame}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, FRAME_DELAY_MS));
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, models: MODELS.length });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(res, 200, { object: "list", data: MODELS });
  }

  if (req.method === "POST" && url.pathname === "/v1/embeddings") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "invalid JSON body" } });
    }
    return handleEmbeddings(res, body);
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "invalid JSON body" } });
    }

    const model = String(body.model || "");

    // Explicit error scenarios, with the shapes the client must handle honestly.
    if (model === "mock/402") {
      return sendJson(res, 402, {
        error: {
          code: "BUDGET_EXCEEDED",
          message: "Monthly budget exhausted. Top up to continue.",
          details: { limit_microcents: 5_000_000, used_microcents: 5_000_000 },
        },
      });
    }
    if (model === "mock/429") {
      return sendJson(
        res,
        429,
        { error: { code: "RATE_LIMITED", message: "Too many requests." } },
        { "retry-after": "7" },
      );
    }

    const fixture = SCENARIOS[model];
    if (!fixture) {
      return sendJson(res, 404, {
        error: { code: "NOT_FOUND", message: `unknown mock model: ${model}` },
      });
    }
    return streamFixture(res, fixture);
  }

  return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock] listening on http://${HOST}:${PORT} — ${MODELS.length} models`);
});

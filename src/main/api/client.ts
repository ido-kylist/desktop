import { z } from "zod";
import { AppError } from "../errors.js";
import { parseSse } from "./sse.js";

/**
 * The OpenAI-compatible streaming transport.
 *
 * This module owns exactly three things: where the request goes, what the bytes
 * mean, and which failure is which. It owns no persistence, emits no IPC events,
 * and knows nothing about generations — the orchestrator in `generations.ts` does
 * all of that, which is why this file is testable with a fake `fetch` and nothing
 * else.
 */

/** The dev-time server. Only reachable while the app is unpackaged (see below). */
export const MOCK_BASE_URL = "http://127.0.0.1:4790";

/**
 * The wire thinks in four finish reasons; `error` exists in the contract for
 * failures, and a model never reports it, so it is not accepted from upstream.
 */
const FINISH_REASONS = ["stop", "length", "tool_calls", "content_filter"] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

export interface InferenceConfig {
  baseUrl: string;
  apiKey: string | null;
}

/**
 * Where inference lives, in priority order: an explicit override, then the local
 * mock while unpackaged, then a hard failure.
 *
 * The packaged case deliberately throws rather than falling back to the mock: a
 * shipped build that quietly talks to 127.0.0.1 would look like a working app
 * while answering from a fixture, and nothing downstream could tell the
 * difference. `INTERNAL` because it is a misconfiguration of this app, not an
 * upstream fault. The raw `process.env` is read by the caller, so this stays a
 * pure function of its inputs.
 */
export function resolveBaseUrl(input: {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}): string {
  const configured = input.env.CLEON_API_BASE?.trim() ?? "";
  if (configured !== "") return configured.replace(/\/+$/, "");
  if (!input.isPackaged) return MOCK_BASE_URL;
  throw new AppError("INTERNAL", "no inference base URL configured");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * One normalised piece of the upstream stream. Providers differ in where they
 * put reasoning, how they index tool calls and how they attach usage; that
 * variation is flattened here so the orchestrator has one shape to switch on.
 */
export type ChatDelta =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCallDelta"; index: number; callId?: string; name?: string; args?: string }
  | { type: "finish"; reason: FinishReason }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      costMicrocents: number;
    };

/**
 * What the framing said versus what the payload said. Truncation is decided from
 * this, not from an exception: a stream can be perfectly well-framed and still
 * stop before it was finished (`mock/truncated` is exactly that).
 */
export interface StreamOutcome {
  /** Whether the provider sent `data: [DONE]`. */
  sawDone: boolean;
  /** The last non-null `finish_reason`, or null if the model never finished. */
  finishReason: FinishReason | null;
}

export interface StreamChatInput {
  config: InferenceConfig;
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta: (delta: ChatDelta) => void;
  /** Injected by tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

/* ------------------------------------------------------------- wire shapes */

const toolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  id: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

/**
 * Deliberately permissive about fields we ignore and strict about the ones we
 * read. A chunk carrying an unknown finish reason is an upstream protocol change,
 * and reporting it as a finished answer would be a lie, so it fails loudly.
 */
const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            tool_calls: z.array(toolCallDeltaSchema).nullish(),
          })
          .optional(),
        finish_reason: z.enum(FINISH_REASONS).nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      cost_microcents: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

type Chunk = z.infer<typeof chunkSchema>;

const MAX_PREVIEW_CHARS = 800;

function preview(text: string): string {
  return text.length <= MAX_PREVIEW_CHARS ? text : `${text.slice(0, MAX_PREVIEW_CHARS)}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeChunk(raw: string): Chunk {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new AppError("UPSTREAM_ERROR", "inference stream sent a frame that is not JSON", {
      details: { frame: preview(raw) },
      cause: error,
    });
  }

  const parsed = chunkSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError("UPSTREAM_ERROR", "inference stream sent an unrecognised chunk", {
      details: { frame: preview(raw), issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/**
 * `Retry-After` is defined in seconds. The HTTP-date form is legal too, but no
 * provider in the taxonomy sends it, and a countdown built from a guessed date is
 * worse than none — an unparseable header yields no hint at all.
 */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

interface ErrorBody {
  /** The provider's own message, when the body carries a usable one. */
  message: string | null;
}

/**
 * Best-effort description of a failed response. A non-JSON body is expected from
 * proxies and achieved by degrading to the raw text, so the parse failure is
 * handled here rather than propagated.
 */
async function readErrorBody(response: Response): Promise<ErrorBody> {
  const text = await response.text().catch(() => "");
  if (text === "") return { message: null };

  try {
    const parsed: unknown = JSON.parse(text);
    const message = z
      .object({ error: z.object({ message: z.string() }).partial() })
      .partial()
      .safeParse(parsed);
    if (message.success && typeof message.data.error?.message === "string") {
      return { message: message.data.error.message };
    }
  } catch {
    // Not JSON. The raw body is the only description available.
  }
  return { message: preview(text) };
}

async function httpError(response: Response): Promise<AppError> {
  const body = await readErrorBody(response);
  const message = body.message ?? `inference request failed with status ${response.status}`;
  const details = { status: response.status };

  if (response.status === 402) {
    return new AppError("BUDGET_EXCEEDED", message, { details });
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    return new AppError("RATE_LIMITED", message, {
      details,
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    });
  }
  return new AppError("UPSTREAM_ERROR", message, { details });
}

function requestHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  // No key means no header at all: the mock ignores auth, and sending an empty
  // bearer would be a malformed request against a real provider.
  if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Reads a response body as chunks, explicitly.
 *
 * Not `for await (const chunk of response.body)`: async iteration of a
 * ReadableStream is a platform feature whose type is only present when the
 * async-iterable lib is loaded, and this module is typechecked in more than one
 * lib configuration. Reading through the reader is the same bytes with no hidden
 * dependency — and it gives the cancellation on early exit (`data: [DONE]`) an
 * obvious home.
 */
async function* readBody(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // Stops the response at the source when the consumer leaves early, instead of
    // leaving a half-read body to be cleaned up whenever the socket closes.
    await reader.cancel().catch(() => undefined);
  }
}

/* ---------------------------------------------------------------- transport */

/**
 * Streams one completion, reporting each delta as it arrives.
 *
 * Resolves with the framing summary once the body ends; the caller decides
 * whether that summary describes a finished answer. Throws `AppError` for a
 * failed request, and rethrows an abort untouched — a user stop is not a failure
 * and must stay distinguishable without matching on error names.
 */
export async function streamChatCompletion(input: StreamChatInput): Promise<StreamOutcome> {
  const send = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await send(`${input.config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: requestHeaders(input.config.apiKey),
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw new AppError("UPSTREAM_ERROR", "inference request failed", {
      details: { reason: describe(error) },
      cause: error,
    });
  }

  if (!response.ok) throw await httpError(response);
  if (response.body === null) {
    throw new AppError("UPSTREAM_ERROR", "inference response carried no body", {
      details: { status: response.status },
    });
  }

  let sawDone = false;
  let finishReason: FinishReason | null = null;

  for await (const frame of parseSse(readBody(response.body))) {
    const data = frame.data.trim();
    if (data === "") continue;
    if (data === "[DONE]") {
      sawDone = true;
      break;
    }

    const chunk = decodeChunk(data);
    const choice = chunk.choices?.[0];

    if (choice?.delta !== undefined) {
      const delta = choice.delta;
      if (delta.reasoning_content) {
        input.onDelta({ type: "reasoning", text: delta.reasoning_content });
      }
      if (delta.content) {
        input.onDelta({ type: "content", text: delta.content });
      }
      for (const call of delta.tool_calls ?? []) {
        input.onDelta({
          type: "toolCallDelta",
          index: call.index ?? 0,
          ...(call.id === undefined ? {} : { callId: call.id }),
          ...(call.function?.name === undefined ? {} : { name: call.function.name }),
          ...(call.function?.arguments === undefined ? {} : { args: call.function.arguments }),
        });
      }
    }

    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
      input.onDelta({ type: "finish", reason: choice.finish_reason });
    }

    if (chunk.usage !== undefined) {
      input.onDelta({
        type: "usage",
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        // The wire has no cost field; providers that bill in this unit send it as
        // an extension, and everything else reports zero until pricing lands.
        costMicrocents: chunk.usage.cost_microcents ?? 0,
      });
    }
  }

  return { sawDone, finishReason };
}

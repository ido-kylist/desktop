import { z } from "zod";
import { AppError } from "../errors.js";
import { l2Normalise } from "../knowledge/cosine.js";
import { httpError, type InferenceConfig } from "./client.js";

/**
 * The embeddings request behind retrieval.
 *
 * OpenAI-compatible by the same bet the chat transport makes: `POST {baseUrl}/v1/embeddings`
 * with `{ model, input }` and a `data` array of `{ embedding, index }` back. Providers that
 * speak the chat completions dialect almost always speak this one, and the alternative — a
 * second provider abstraction — buys nothing this app can use.
 *
 * The model is a setting (`embeddingModel`), not a constant: a self-hosted endpoint does not
 * serve `text-embedding-3-small`, and the person who configured that endpoint knows what it
 * does serve.
 *
 * Nothing is retried here. A 429 is `RATE_LIMITED` with the provider's `Retry-After` intact,
 * which is the one thing a caller can act on; a silent retry loop would turn a rate limit
 * into a longer rate limit.
 */

/** The default, overridable through `settings.embeddingModel`. */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * How many strings one request carries.
 *
 * The endpoint takes an array, so a 40-chunk document costs one request instead of forty.
 * The cap is not the provider's: it is a bound on how large a single body can get, so a
 * 500-chunk file is five requests rather than one the transport refuses.
 */
const BATCH_SIZE = 64;

/** A retrieval is interactive: a metadata read that takes longer than this has failed. */
const TIMEOUT_MS = 15_000;

const embeddingsResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().int().nonnegative().optional(),
    }),
  ),
});

export interface EmbedInput {
  config: InferenceConfig;
  model: string;
  texts: readonly string[];
  /** Injected by tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * One vector per input string, in input order, L2-normalised.
 *
 * Order is restored from `index` when the provider sends it: the specification allows the
 * array to come back in any order, and a silently permuted batch would attach every chunk
 * to the wrong vector — a defect that reads as "search is bad" and takes days to find.
 */
export async function embedTexts(input: EmbedInput): Promise<Float32Array[]> {
  if (input.texts.length === 0) return [];

  const vectors: Float32Array[] = [];
  for (let start = 0; start < input.texts.length; start += BATCH_SIZE) {
    const batch = input.texts.slice(start, start + BATCH_SIZE);
    const embedded = await embedBatch(input, batch);
    vectors.push(...embedded);
  }

  return vectors;
}

async function embedBatch(input: EmbedInput, batch: readonly string[]): Promise<Float32Array[]> {
  const send = input.fetchImpl ?? fetch;
  const url = `${input.config.baseUrl}/v1/embeddings`;

  let response: Response;
  try {
    response = await send(url, {
      method: "POST",
      headers: requestHeaders(input.config.apiKey),
      body: JSON.stringify({ model: input.model, input: batch }),
      // Own signal: the caller has no way to cancel a retrieval, and the alternative to a
      // deadline is a send that hangs on a provider that stopped answering.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AppError("UPSTREAM_ERROR", `the embedding provider did not answer in time`, {
        details: { reason: "timeout", url, timeoutMs: TIMEOUT_MS },
      });
    }
    throw new AppError("UPSTREAM_ERROR", "embedding request failed", {
      details: { reason: describe(error), url },
      cause: error,
    });
  }

  if (!response.ok) throw await httpError(response);

  const parsed = embeddingsResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError("UPSTREAM_ERROR", "embedding response was not in the expected shape", {
      details: { reason: "bad_shape", url },
    });
  }

  const returned = parsed.data.data;
  if (returned.length !== batch.length) {
    throw new AppError("UPSTREAM_ERROR", "embedding response did not match the request", {
      details: { reason: "count_mismatch", sent: batch.length, got: returned.length },
    });
  }

  const byIndex = new Map<number, number[]>();
  returned.forEach((item, position) => {
    byIndex.set(item.index ?? position, item.embedding);
  });

  const vectors: Float32Array[] = [];
  for (let position = 0; position < batch.length; position += 1) {
    const embedding = byIndex.get(position);
    if (embedding === undefined) {
      throw new AppError("UPSTREAM_ERROR", "embedding response skipped an input", {
        details: { reason: "missing_index", index: position },
      });
    }
    // A provider that returns vectors of differing lengths for the same model is broken,
    // but the failure would otherwise surface later as a dimension mismatch on one chunk.
    if (vectors.length > 0 && embedding.length !== (vectors[0]?.length ?? 0)) {
      throw new AppError("UPSTREAM_ERROR", "embedding provider returned inconsistent dimensions", {
        details: {
          reason: "ragged_dimensions",
          expected: vectors[0]?.length ?? 0,
          got: embedding.length,
        },
      });
    }
    vectors.push(l2Normalise(Float32Array.from(embedding)));
  }

  return vectors;
}

/** No key means no header at all, exactly as the chat transport decides it. */
function requestHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

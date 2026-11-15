import { z } from "zod";
import { MOCK_BASE_URL } from "./client.js";

/**
 * The model catalog read behind `models.list`.
 *
 * This feeds a settings screen, not a conversation, and that single fact decides
 * everything about its behaviour: it **never throws**. A failed catalog request is
 * a smaller problem than a settings screen that cannot render, so every failure
 * degrades to a built-in list and a sentence saying so. The `source` field is what
 * keeps that honest — the UI can say where the list came from instead of implying
 * the provider vouched for it.
 *
 * No credentials are handled here beyond attaching the bearer; the key never leaves
 * the main process (invariant 2).
 */

export interface ModelSummary {
  id: string;
  /** Who serves the model, when the provider says. `null` when it does not. */
  ownedBy: string | null;
}

export interface ListModelsResult {
  models: ModelSummary[];
  source: "remote" | "fallback" | "mock";
  /** Set only when `source` is `fallback`: what went wrong, in words a person reads. */
  message: string | null;
}

export interface ListModelsInput {
  baseUrl: string;
  apiKey: string | null;
  /** Injected by tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

/** A catalog is a convenience, not a turn: waiting longer than this helps nobody. */
const TIMEOUT_MS = 5_000;

/**
 * The mock server's catalog, mirrored rather than fetched.
 *
 * Dev builds default to the mock base URL whether or not `mock/server.mjs` is
 * running — and a settings screen that reports "could not reach the provider" for
 * the app's own default configuration would be telling the user their working setup
 * is broken. The ids match `mock/server.mjs`; the integration test pins them.
 */
const MOCK_MODELS: readonly ModelSummary[] = [
  { id: "mock/text", ownedBy: "cleon-mock" },
  { id: "mock/reasoning", ownedBy: "cleon-mock" },
  { id: "mock/tool", ownedBy: "cleon-mock" },
  { id: "mock/truncated", ownedBy: "cleon-mock" },
  { id: "mock/402", ownedBy: "cleon-mock" },
  { id: "mock/429", ownedBy: "cleon-mock" },
];

/**
 * What the picker offers when the provider will not say.
 *
 * Deliberately short and deliberately generic: these are ids an OpenAI-compatible
 * endpoint is likely to accept, not a claim about what the account can reach. The
 * user can always type the id their provider documents, and `message` tells them
 * why this list is on screen at all.
 */
const FALLBACK_MODELS: readonly ModelSummary[] = [
  { id: "gpt-4o", ownedBy: null },
  { id: "gpt-4o-mini", ownedBy: null },
  { id: "gpt-4.1", ownedBy: null },
  { id: "o3-mini", ownedBy: null },
];

/**
 * Only the two fields this module reports. Providers add `object`, `created`,
 * `permission`, and whatever else; being strict about those would turn a working
 * provider into a fallback for no benefit, so they are simply not declared.
 */
const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string(), owned_by: z.string().nullish() })),
});

export async function listModels(input: ListModelsInput): Promise<ListModelsResult> {
  if (input.baseUrl === MOCK_BASE_URL) {
    return { models: [...MOCK_MODELS], source: "mock", message: null };
  }

  const send = input.fetchImpl ?? fetch;

  try {
    const response = await send(`${input.baseUrl}/v1/models`, {
      method: "GET",
      headers: requestHeaders(input.apiKey),
      // Own signal: this request has no caller who could abort it, and the
      // alternative to a deadline is a settings screen that waits forever.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      return fallback(`The provider answered with status ${response.status}`);
    }

    const parsed = modelsResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return fallback("The provider's model list was not in the expected shape");
    }

    return {
      models: parsed.data.data.map((item) => ({ id: item.id, ownedBy: item.owned_by ?? null })),
      source: "remote",
      message: null,
    };
  } catch (error) {
    return fallback(describeFailure(error));
  }
}

function fallback(reason: string): ListModelsResult {
  return {
    models: [...FALLBACK_MODELS],
    source: "fallback",
    message: `${reason}. Showing a built-in list instead.`,
  };
}

/**
 * No key means no header at all: an empty bearer is a malformed request against a
 * provider that wants one, and against one that does not want one it is noise.
 */
function requestHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Turns whatever the transport threw into a sentence. A timeout is called by name
 * because "the request was aborted" describes the mechanism, not the wait the user
 * sat through; everything else keeps its own message, which is where a DNS or TLS
 * failure explains itself.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `The provider did not answer within ${TIMEOUT_MS / 1000} seconds`;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not reach the provider (${reason})`;
}

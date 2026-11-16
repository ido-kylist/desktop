import type { IpcError, ResponseOf } from "@shared/ipc-contract";

/**
 * The model catalogue, as the renderer sees it.
 *
 * `models.list` is the only source of selectable models (P0): the ids belong to
 * whatever endpoint the user configured, so this file must not carry a list of its
 * own. The one exception is the mock's scenarios, and only when the platform says
 * the endpoint *is* the mock (`source === "mock"`) — that is what keeps the
 * error-state demo reachable without pretending a real provider offers `mock/402`.
 *
 * Everything here is pure. The hook owns the fetch, the components own the pixels,
 * and this module owns the mapping between the two so it can be asserted exactly.
 */

export type ModelCatalogResult = ResponseOf<"models.list">;
export type ModelSource = ModelCatalogResult["source"];

export interface ModelOption {
  id: string;
  ownedBy: string | null;
}

/** The mock server's scenarios (`mock/server.mjs`); selectable only against the mock. */
export const MOCK_MODEL_IDS = [
  "mock/text",
  "mock/reasoning",
  "mock/tool",
  "mock/truncated",
  "mock/402",
  "mock/429",
] as const;

/**
 * The last resort, used only while no catalogue is on screen yet. It is a mock id
 * because the unpackaged app talks to the mock by default; once a catalogue arrives
 * the first model in it wins, and a stored default wins over both.
 */

/**
 * The select's options: the endpoint's list, de-duplicated in the order it gave,
 * plus the mock scenarios when that is honestly all this endpoint is.
 */
export function modelOptions(result: ModelCatalogResult): ModelOption[] {
  const options: ModelOption[] = [];
  const seen = new Set<string>();

  for (const model of result.models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    options.push({ id: model.id, ownedBy: model.ownedBy });
  }

  // `mock` means the platform answered from its own fixtures, so those fixtures are
  // the whole catalogue — including the failure scenarios, which are precisely what
  // the demo needs. `fallback` is a real endpoint that did not answer; its ids are a
  // best guess and adding mock ids to them would be an invention.
  if (result.source === "mock") {
    for (const id of MOCK_MODEL_IDS) {
      if (seen.has(id)) continue;
      seen.add(id);
      options.push({ id, ownedBy: null });
    }
  }

  return options;
}

/**
 * Where the list came from, said plainly. The token itself is on screen — `remote`,
 * `fallback` or `mock` — because a built-in list must never read as a live one: the
 * user is about to pick a model that may not exist.
 */
export function describeModelSource(source: ModelSource, message: string | null): string {
  switch (source) {
    case "remote":
      return "Source: remote — read from the configured endpoint.";
    case "fallback":
      return message === null
        ? "Source: fallback — using a built-in list; the endpoint did not answer."
        : `Source: fallback — using a built-in list; the endpoint did not answer. ${message}`;
    case "mock":
      return "Source: mock — the endpoint is the mock server, so these are its built-in scenarios.";
  }
}

export interface ModelCatalogInput {
  loading: boolean;
  result: ModelCatalogResult | null;
  error: IpcError | null;
}

/**
 * The four states a catalogue fetch can be in. They are kept apart because an empty
 * select, a failed select, and a select that has not answered yet are three different
 * things to a user, and rendering all of them as "no models" hides a failure.
 */
export type ModelCatalog =
  | { state: "loading" }
  | { state: "error"; error: IpcError }
  | { state: "empty"; source: ModelSource; note: string }
  | { state: "ready"; source: ModelSource; note: string; options: ModelOption[] };

export function buildModelCatalog(input: ModelCatalogInput): ModelCatalog {
  // The failure wins over everything, including a cached list. A refetch that failed
  // leaves the previous data in the query cache; showing it would read as "these are
  // the models" when the truth is "the endpoint did not answer".
  if (input.error !== null) return { state: "error", error: input.error };
  if (input.loading || input.result === null) return { state: "loading" };

  const note = describeModelSource(input.result.source, input.result.message);
  const options = modelOptions(input.result);
  if (options.length === 0) return { state: "empty", source: input.result.source, note };

  return { state: "ready", source: input.result.source, note, options };
}

/**
 * The configured model, verbatim.
 *
 * Nothing here consults the catalogue. A model id is a free-form string to the wire —
 * `/deployments/d62861ef/deepseek-ai/…` is valid even though no `/v1/models` response
 * lists it — so an endpoint's catalogue is a suggestion, never an authority over what
 * the user typed. `null` means "unset"; an empty string means "the user cleared it",
 * and those are different answers.
 */
export function configuredModel(
  chosen: string | null,
  saved: string | null | undefined,
): string | null {
  return chosen ?? saved ?? null;
}

/**
 * Used only when nothing is configured — a fresh profile. The endpoint's own first
 * answer is a defensible default; substituting it for a configured value is not.
 */
export function firstCatalogModel(catalog: ModelCatalog): string {
  return catalog.state === "ready" ? (catalog.options[0]?.id ?? "") : "";
}

export interface CatalogLine {
  tone: "ok" | "warn" | "bad" | "muted";
  text: string;
}

/**
 * One line describing the catalogue, shared by the composer and the settings screen
 * so the two surfaces cannot disagree about what just happened. The tone carries the
 * part that words alone make easy to skim past: `mock` and `fallback` are warnings,
 * not successes.
 */
export function describeCatalog(catalog: ModelCatalog): CatalogLine {
  switch (catalog.state) {
    case "loading":
      return { tone: "muted", text: "Loading models…" };

    case "error":
      return { tone: "bad", text: `${catalog.error.code}: ${catalog.error.message}` };

    case "empty":
      return {
        tone: "warn",
        text: `The endpoint returned no models. ${catalog.note}`,
      };

    case "ready": {
      const count = catalog.options.length;
      const models = `${count} model${count === 1 ? "" : "s"} available.`;
      return {
        tone: catalog.source === "remote" ? "ok" : "warn",
        text: `${models} ${catalog.note}`,
      };
    }
  }
}

/** True when the typed id is one the endpoint actually advertises. */
export function isModelInCatalog(catalog: ModelCatalog, value: string): boolean {
  const id = value.trim();
  if (id === "" || catalog.state !== "ready") return false;
  return catalog.options.some((option) => option.id === id);
}

/**
 * The id a provider is asking for when it rejects a bare model with
 * `INVALID_DEPLOYMENT_TARGET`. Returns null when the error is not that, or when the
 * value already carries a prefix — a double prefix is never suggested.
 */
export function suggestDeploymentModel(message: string, current: string): string | null {
  const id = current.trim().replace(/^\/+/, "");
  if (id === "") return null;
  if (id.startsWith("deployments/")) return null;
  if (!message.includes("INVALID_DEPLOYMENT_TARGET") && !message.includes("/deployments/")) {
    return null;
  }
  // The provider's own text is a template (`/deployments/{serverless|poolId}/`), which
  // the character class deliberately does not match; a concrete pool id does match.
  const concrete = /deployments\/([A-Za-z0-9_-]+)\//.exec(message);
  const target = concrete?.[1] ?? "serverless";
  return `/deployments/${target}/${id}`;
}

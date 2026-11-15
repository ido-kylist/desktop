import type { IpcError } from "@shared/ipc-contract";
import type { CatalogLine } from "./models";

/**
 * The four states a list fetch can be in, for every list the D6 surfaces draw:
 * projects, assistants, prompts.
 *
 * Kept as one generic instead of three copies, because the whole point is that the
 * four states are *the same four* everywhere. The bug this exists to prevent is subtle
 * and was called out in the brief: a failed fetch rendering as an empty list. A user
 * cannot tell "you have no assistants" from "we could not read your assistants", and
 * one of those is a problem to fix.
 */
export type Catalog<T> =
  | { state: "loading" }
  | { state: "error"; error: IpcError }
  | { state: "empty" }
  | { state: "ready"; items: readonly T[] };

export interface CatalogInput<T> {
  /** True while the first read is in flight, or during a refetch with no data yet. */
  loading: boolean;
  /** Undefined means "no answer yet", which is loading, not empty. */
  result: readonly T[] | undefined;
  error: IpcError | null;
}

export function buildCatalog<T>(input: CatalogInput<T>): Catalog<T> {
  // The failure wins over everything, including cached data: a refetch that failed
  // leaves the previous list in the query cache, and showing it would read as "this is
  // your library" when the truth is "the last read failed".
  if (input.error !== null) return { state: "error", error: input.error };
  if (input.loading || input.result === undefined) return { state: "loading" };
  if (input.result.length === 0) return { state: "empty" };
  return { state: "ready", items: input.result };
}

export interface CatalogLabels {
  /** Plural noun, lowercase: "projects", "assistants", "prompts". */
  noun: string;
  /** What to say when the read succeeded and there is nothing in it. */
  empty: string;
}

/**
 * One line per state, in the same shape the model catalogue already uses, so a surface
 * can render a list's status without inventing its own vocabulary for it.
 */
export function describeCatalogState<T>(catalog: Catalog<T>, labels: CatalogLabels): CatalogLine {
  switch (catalog.state) {
    case "loading":
      return { tone: "muted", text: `Loading ${labels.noun}…` };
    case "error":
      return { tone: "bad", text: `${catalog.error.code}: ${catalog.error.message}` };
    case "empty":
      return { tone: "muted", text: labels.empty };
    case "ready": {
      const count = catalog.items.length;
      return { tone: "ok", text: `${count} ${count === 1 ? singular(labels.noun) : labels.noun}.` };
    }
  }
}

/** "assistants" → "assistant". Only used for a count of one, so the naive rule is enough. */
function singular(noun: string): string {
  return noun.endsWith("s") ? noun.slice(0, -1) : noun;
}

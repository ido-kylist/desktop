import type { ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { listAssistants } from "../lib/ipc";

/**
 * The assistant picker's read (D6).
 *
 * Only live assistants are offered: an archived one can still be resolved by main (a
 * thread that was sent with it keeps working) but it should not be offered for new
 * turns, which is exactly what `includeArchived: false` says.
 *
 * The query is returned as-is rather than pre-shaped into a `Catalog`: the caller builds
 * that with `buildCatalog`, which is the pure function the state tests pin down. Two
 * adapters between the same two types would be one too many.
 */

export type AssistantSummary = ResponseOf<"assistants.list">["items"][number];

export const ASSISTANT_LIST_KEY = ["assistants.list"] as const;

export function useAssistants() {
  return useQuery({
    queryKey: [...ASSISTANT_LIST_KEY, false],
    queryFn: () => listAssistants({ includeArchived: false }),
    retry: false,
  });
}

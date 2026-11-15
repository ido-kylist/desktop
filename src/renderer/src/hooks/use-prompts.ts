import type { ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { listPrompts } from "../lib/ipc";

/**
 * The prompt library's read (D6).
 *
 * Search is the server's: `prompts.list` matches `query` against title and body in SQL,
 * so this hook never filters. The term is part of the query key, which makes a new term
 * a new request rather than a mutation of the old answer — the same pattern the thread
 * search uses.
 */

export type PromptSummary = ResponseOf<"prompts.list">["items"][number];

export const PROMPT_LIST_KEY = ["prompts.list"] as const;

/** One page is the whole library for a local app; the contract's paging stays honest. */
export const PROMPT_PAGE_SIZE = 200;

export function usePrompts(query: string) {
  return useQuery({
    queryKey: [...PROMPT_LIST_KEY, query],
    queryFn: () =>
      listPrompts({
        ...(query === "" ? {} : { query }),
        limit: PROMPT_PAGE_SIZE,
        offset: 0,
      }),
    retry: false,
  });
}

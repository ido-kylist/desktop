import type { RequestOf, ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { listThreads } from "../lib/ipc";

/**
 * The history list (D2). Search is the server's: `threads.list` runs FTS5 over the
 * message text and decides what matches, so the rows are never filtered here. The
 * term is part of the query key, which is what makes a new term a new request rather
 * than a mutation of the old result.
 *
 * One page is enough for a local history and keeps the contract's required
 * `limit`/`offset` honest; the list is windowed, so a long page costs nothing to
 * render. The server already sorts pinned threads first — this keeps the order it
 * returns instead of re-sorting and disagreeing with the snippet ranking.
 */

export type ThreadSummary = ResponseOf<"threads.list">["items"][number];

/** The fields a row action may change; `threadId` is carried separately. */
export type ThreadPatch = Pick<RequestOf<"threads.update">, "title" | "pinned" | "archived">;

export const THREAD_PAGE_SIZE = 200;

/** Prefix for every list query, used to invalidate all terms at once. */
export const THREAD_LIST_KEY = ["threads.list"] as const;

export function useThreadList(query: string, includeArchived: boolean, projectId: string | null) {
  return useQuery({
    queryKey: [...THREAD_LIST_KEY, query, includeArchived, projectId],
    queryFn: () =>
      listThreads({
        ...(query === "" ? {} : { query }),
        ...(projectId === null ? {} : { projectId }),
        limit: THREAD_PAGE_SIZE,
        offset: 0,
        includeArchived,
      }),
  });
}

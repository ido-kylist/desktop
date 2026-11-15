import type { ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { listKnowledgeDocuments } from "../lib/ipc";

/**
 * The knowledge panel's read (D8).
 *
 * One keyed read, shared by everything that needs the list: the documents table and the
 * "use knowledge" toggle's count. Writes invalidate this key rather than patching it, so the
 * list after an add or a delete is what main wrote, not what the panel hoped it wrote.
 *
 * A failed read is the query's error, not an empty list. "Nothing indexed yet" and "the read
 * failed" are different states, and a panel that showed the first for the second would have
 * the user re-adding files that are already there.
 */

export type KnowledgeDocumentView = ResponseOf<"kb.listDocuments">["items"][number];

export const KNOWLEDGE_LIST_KEY = ["kb.listDocuments"] as const;

export function useKnowledgeDocuments() {
  return useQuery({
    queryKey: KNOWLEDGE_LIST_KEY,
    queryFn: () => listKnowledgeDocuments(),
    retry: false,
  });
}

import type { ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { getArtifact, listArtifacts } from "../lib/ipc";

/**
 * The artifacts panel's two reads (D8).
 *
 * The list is keyed by thread, because that is the only scope an artifact has: opening
 * another conversation must not show this one's documents. The history is keyed by artifact
 * and disabled until one is selected — a panel that fetched every version of every artifact
 * on open would read the whole corpus to draw a list of titles.
 *
 * Both throw (`callOrThrow`), so TanStack Query owns the failure and the panel renders it as
 * a state rather than as an empty list.
 */

export type ArtifactView = ResponseOf<"artifacts.list">["items"][number];
export type ArtifactHistoryView = ResponseOf<"artifacts.get">;

export function artifactListKey(threadId: string | null): readonly unknown[] {
  return ["artifacts.list", threadId];
}

export function artifactHistoryKey(artifactId: string | null): readonly unknown[] {
  return ["artifacts.get", artifactId];
}

export function useArtifacts(threadId: string | null) {
  return useQuery({
    queryKey: artifactListKey(threadId),
    queryFn: () => {
      // Unreachable by contract: the query is disabled with no thread. Thrown rather than
      // returning an empty list so a mistake here cannot look like "this thread has none".
      if (threadId === null) throw new Error("no thread selected");
      return listArtifacts(threadId);
    },
    enabled: threadId !== null,
    retry: false,
  });
}

export function useArtifactHistory(artifactId: string | null) {
  return useQuery({
    queryKey: artifactHistoryKey(artifactId),
    queryFn: () => {
      if (artifactId === null) throw new Error("no artifact selected");
      return getArtifact(artifactId);
    },
    enabled: artifactId !== null,
    retry: false,
  });
}

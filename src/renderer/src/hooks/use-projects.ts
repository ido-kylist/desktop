import type { ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { listProjects } from "../lib/ipc";

/**
 * The sidebar's project list (D6).
 *
 * One keyed read, shared by the section that lists them and the composer that files a
 * new chat into one. Writes invalidate it, so the section always shows main's answer
 * rather than a name patched in optimistically that main might have refused.
 */

export type ProjectSummary = ResponseOf<"projects.list">["items"][number];

export const PROJECT_LIST_KEY = ["projects.list"] as const;

export function useProjects() {
  return useQuery({
    queryKey: PROJECT_LIST_KEY,
    queryFn: () => listProjects(),
    retry: false,
  });
}

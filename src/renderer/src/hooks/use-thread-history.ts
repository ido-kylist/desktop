import type { IpcError, ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { IpcFailure, loadThread, toIpcError } from "../lib/ipc";
import { buildThreadView, type VariantGroup } from "../lib/variants";
import { type ChatMessageView, useChatStore } from "../store/chat-store";

/**
 * The history read (gate G1). TanStack Query earns its keep here and not in the live
 * stream: one cached, keyed read per thread, no polling, and a request that does not
 * re-fire when the component re-renders on every token.
 *
 * The query result is written into the chat store, and only when it cannot clobber
 * something better: a live stream, or a conversation that has already moved past the
 * snapshot. The store's own hydration merges a live turn's text over the snapshot, so
 * the refresh that follows a variant switch or a regenerate cannot truncate an answer
 * that is still arriving.
 *
 * D3: the flat list main returns is a tree. `buildThreadView` reduces it to the active
 * path — which is what the transcript renders — and hands back the sibling sets for
 * that path, which is what the switcher counts.
 */

const NO_GROUPS: Record<string, VariantGroup> = {};

function toMessageView(message: ResponseOf<"chat.thread">["messages"][number]): ChatMessageView {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    // Reasoning and tool calls are not persisted as their own rows in D1, so a
    // restored turn is text only. The live stream is the only source of both.
    reasoning: "",
    toolCalls: [],
    createdAt: message.createdAt,
    generationId: message.generationId,
    errorCode: message.errorCode,
    lastSeq: 0,
    usage: message.usage ?? null,
  };
}

export interface ThreadHistory {
  loading: boolean;
  error: IpcError | null;
  /** Sibling sets for the active path, keyed by message id. */
  groups: Record<string, VariantGroup>;
  /** Re-reads the thread and puts the server's active path on screen. */
  reload: () => Promise<void>;
}

export function useThreadHistory(threadId: string | null): ThreadHistory {
  const hydrate = useChatStore((state) => state.hydrate);
  const forgetThread = useChatStore((state) => state.forgetThread);

  const query = useQuery({
    queryKey: ["chat.thread", threadId],
    queryFn: async (): Promise<ResponseOf<"chat.thread">> => {
      if (threadId === null) throw new Error("no thread to load");
      return loadThread(threadId);
    },
    enabled: threadId !== null,
    retry: false,
    // A restored thread is not stale within a session: nothing else writes it, and a
    // refetch would only race the live stream. The switch and regenerate paths refetch
    // explicitly, which is the one case that does want a fresh read.
    staleTime: Number.POSITIVE_INFINITY,
  });

  const snapshot = query.data;
  const view = useMemo(
    () =>
      snapshot === undefined ? null : buildThreadView(snapshot.messages, snapshot.activeLeafId),
    [snapshot],
  );

  useEffect(() => {
    if (snapshot === undefined || view === null) return;
    // Cached data belongs to the thread it was read for; a selection change must not
    // be hydrated from another thread's snapshot.
    if (snapshot.thread.id !== threadId) return;
    const state = useChatStore.getState();
    if (state.streaming !== null) return;
    if (state.threadId === threadId && state.messages.length > 0) return;
    // `threadId` is a dependency as well as a guard: re-selecting a thread whose query
    // is still cached (nothing else changed) has to put its transcript back on screen.
    hydrate(threadId, view.path.map(toMessageView));
  }, [snapshot, view, threadId, hydrate]);

  const { refetch } = query;
  const reload = useCallback(async () => {
    const result = await refetch();
    if (result.data === undefined) return;
    const fresh = buildThreadView(result.data.messages, result.data.activeLeafId);
    hydrate(result.data.thread.id, fresh.path.map(toMessageView));
  }, [refetch, hydrate]);

  const error = query.error;
  useEffect(() => {
    if (!(error instanceof IpcFailure)) return;
    // A remembered thread the database no longer has (a wiped profile) must not wedge
    // the app on a permanent error. Forget it and let the next send start a new one.
    if (error.ipc.code === "NOT_FOUND") forgetThread();
  }, [error, forgetThread]);

  return {
    loading: query.isPending && threadId !== null,
    error: toIpcError(error),
    groups: view?.groups ?? NO_GROUPS,
    reload,
  };
}

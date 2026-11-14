import type { IpcError, ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { IpcFailure, loadThread } from "../lib/ipc";
import { type ChatMessageView, useChatStore } from "../store/chat-store";

/**
 * The history read (gate G1). TanStack Query earns its keep here and not in the live
 * stream: one cached, keyed read per thread, no polling, and a request that does not
 * re-fire when the component re-renders on every token.
 *
 * The query result is written into the chat store exactly once, and only when it
 * cannot clobber something better: a live stream, or a conversation that has already
 * moved past the snapshot.
 */

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
  };
}

function toIpcError(error: unknown): IpcError | null {
  if (error === null || error === undefined) return null;
  if (error instanceof IpcFailure) return error.ipc;
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

export interface ThreadHistory {
  loading: boolean;
  error: IpcError | null;
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
    // refetch would only race the live stream.
    staleTime: Number.POSITIVE_INFINITY,
  });

  const snapshot = query.data;

  useEffect(() => {
    if (snapshot === undefined) return;
    const state = useChatStore.getState();
    if (state.streaming !== null) return;
    if (state.threadId === snapshot.thread.id && state.messages.length > 0) return;
    hydrate(snapshot.thread.id, snapshot.messages.map(toMessageView));
  }, [snapshot, hydrate]);

  const error = query.error;
  useEffect(() => {
    if (!(error instanceof IpcFailure)) return;
    // A remembered thread the database no longer has (a wiped profile) must not wedge
    // the app on a permanent error. Forget it and let the next send start a new one.
    if (error.ipc.code === "NOT_FOUND") forgetThread();
  }, [error, forgetThread]);

  return { loading: query.isPending && threadId !== null, error: toIpcError(error) };
}

import type { IpcError } from "@shared/ipc-contract";
import { useCallback, useEffect, useState } from "react";
import { Composer } from "./components/Composer";
import { Diagnostics } from "./components/Diagnostics";
import { ErrorBanner } from "./components/ErrorBanner";
import { MessageList } from "./components/MessageList";
import { useAutoScroll } from "./hooks/use-auto-scroll";
import { useThreadHistory } from "./hooks/use-thread-history";
import { bridge, sendChat, stopGeneration, subscribeToGenerationEvents } from "./lib/ipc";
import { DEFAULT_MODEL } from "./lib/models";
import { type ChatMessageView, THREAD_STORAGE_KEY, useChatStore } from "./store/chat-store";

/**
 * The text a retry would resend: the user turn that produced the last failed answer.
 * Null when the last turn did not fail, which is what keeps a stale banner from
 * outliving its problem.
 */
function findRetryText(messages: readonly ChatMessageView[]): string | null {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "assistant" || last.errorCode === null) return null;

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate !== undefined && candidate.role === "user") return candidate.text;
  }
  return null;
}

/**
 * The read failure and the write failure are different states and are drawn
 * differently: one is "the thread could not be restored", the other is "this turn
 * failed". Both are stated with the contract's code.
 */
function restoreBanner(error: IpcError | null): React.JSX.Element | null {
  if (error === null) return null;
  return (
    <div className="banner" role="alert" data-testid="restore-error">
      <div className="banner-main">
        <span className="banner-code">{error.code}</span>
        <span className="banner-message">{error.message}</span>
      </div>
    </div>
  );
}

export function App(): React.JSX.Element {
  const threadId = useChatStore((state) => state.threadId);
  const messages = useChatStore((state) => state.messages);
  const streaming = useChatStore((state) => state.streaming);
  const lastError = useChatStore((state) => state.lastError);
  const applyEvent = useChatStore((state) => state.applyEvent);
  const startTurn = useChatStore((state) => state.startTurn);
  const clearStreaming = useChatStore((state) => state.clearStreaming);
  const setLastError = useChatStore((state) => state.setLastError);

  const [model, setModel] = useState<string>(DEFAULT_MODEL);

  const history = useThreadHistory(threadId);
  const scroll = useAutoScroll();

  // One subscription for the life of the window; the unsubscribe runs on unmount.
  useEffect(() => subscribeToGenerationEvents(applyEvent), [applyEvent]);

  // The remembered thread id is the only thing this surface persists itself.
  useEffect(() => {
    if (threadId === null) localStorage.removeItem(THREAD_STORAGE_KEY);
    else localStorage.setItem(THREAD_STORAGE_KEY, threadId);
  }, [threadId]);

  const send = useCallback(
    async (text: string) => {
      // Ids come back from main, not from the renderer: main persists the turn and
      // returns its row ids, and the store adopts exactly those.
      const result = await sendChat({ threadId: useChatStore.getState().threadId, text, model });
      if (!result.ok) {
        setLastError(result.error);
        return;
      }
      startTurn({
        threadId: result.data.threadId,
        userMessageId: result.data.userMessageId,
        assistantMessageId: result.data.assistantMessageId,
        generationId: result.data.generationId,
        text,
        createdAt: new Date().toISOString(),
      });
    },
    [model, setLastError, startTurn],
  );

  const stop = useCallback(async () => {
    const active = useChatStore.getState().streaming;
    if (active === null) return;

    // Optimistic, so a lost terminal event cannot leave a dead Stop button on screen.
    // Main still finishes the turn and emits `done`, which clears what is left.
    clearStreaming(active.generationId);

    const result = await stopGeneration(active.generationId);
    if (!result.ok) setLastError(result.error);
  }, [clearStreaming, setLastError]);

  const last = messages[messages.length - 1];
  const turnError: IpcError | null =
    lastError ??
    (last !== undefined && last.role === "assistant" && last.errorCode !== null
      ? // A restored failure has a code but no upstream message: only the code is
        // persisted, and inventing the rest would be a lie.
        { code: last.errorCode, message: "No further detail was stored with this turn." }
      : null);

  const retryText = findRetryText(messages);
  const preloadMissing = bridge() === undefined;

  return (
    <div className="app">
      <header className="bar">
        <span className="mark" />
        <h1>Cleon</h1>
        <span className="tag">D1 · chat</span>
      </header>

      <main className="chat">
        <div className="transcript" ref={scroll.ref} onScroll={scroll.onScroll}>
          <MessageList messages={messages} />
          {history.loading && <p className="muted">Restoring…</p>}
          {restoreBanner(history.error)}
          {turnError !== null && (
            <ErrorBanner
              error={turnError}
              retryText={retryText}
              onRetry={(text) => void send(text)}
            />
          )}
        </div>

        <Composer
          streaming={streaming !== null}
          disabled={preloadMissing}
          model={model}
          onModelChange={setModel}
          onSend={(text) => void send(text)}
          onStop={() => void stop()}
        />
      </main>

      <Diagnostics />
    </div>
  );
}

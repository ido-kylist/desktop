import type { IpcError } from "@shared/ipc-contract";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { Diagnostics } from "./components/Diagnostics";
import { ErrorBanner } from "./components/ErrorBanner";
import { MessageList } from "./components/MessageList";
import { SettingsScreen } from "./components/SettingsScreen";
import { Sidebar } from "./components/Sidebar";
import { UsageTotal } from "./components/UsageMeter";
import { useAutoScroll } from "./hooks/use-auto-scroll";
import { useModelCatalog } from "./hooks/use-model-catalog";
import { useSettings } from "./hooks/use-settings";
import { useThreadHistory } from "./hooks/use-thread-history";
import { THREAD_LIST_KEY } from "./hooks/use-thread-list";
import { sumUsage } from "./lib/format";
import {
  bridge,
  regenerateMessage,
  sendChat,
  setActiveVariant,
  stopGeneration,
  subscribeToGenerationEvents,
} from "./lib/ipc";
import { DEFAULT_MODEL, type ModelOption, resolveDefaultModel } from "./lib/models";
import { type ChatMessageView, THREAD_STORAGE_KEY, useChatStore } from "./store/chat-store";

/** The two surfaces this window has. A typed union, not a router: there is no URL. */
type View = "chat" | "settings";

/** A stable empty list, so the default-model derivation is not re-run for a new ref. */
const NO_OPTIONS: readonly ModelOption[] = [];

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
  const selectThread = useChatStore((state) => state.selectThread);

  const [view, setView] = useState<View>("chat");
  /**
   * The model this window will send. Null means "nobody picked one yet", so the
   * stored default wins — and when even that is absent from the endpoint's catalogue,
   * the first model it lists does. `DEFAULT_MODEL` only covers the gap before any
   * catalogue has arrived.
   */
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const settings = useSettings();
  const { catalog } = useModelCatalog();
  const model =
    resolveDefaultModel(
      chosenModel ?? settings.data?.defaultModel ?? null,
      catalog.state === "ready" ? catalog.options : NO_OPTIONS,
    ) ?? DEFAULT_MODEL;

  const history = useThreadHistory(threadId);
  const reloadThread = history.reload;
  const scroll = useAutoScroll();
  const queryClient = useQueryClient();

  /**
   * A regenerate leaves two answers visible — the one being replaced and the one
   * arriving — until the thread is re-read, because the live stream appends. The
   * re-read happens when the stream ends, not before: a snapshot taken mid-answer
   * would hide the new variant if main had not made it the active leaf yet, and the
   * remaining deltas would have nowhere to land.
   */
  const refreshAfterStream = useRef(false);
  const wasStreaming = useRef(false);

  useEffect(() => {
    const streamingNow = streaming !== null;
    if (wasStreaming.current && !streamingNow) {
      void queryClient.invalidateQueries({ queryKey: THREAD_LIST_KEY });
      if (refreshAfterStream.current) {
        refreshAfterStream.current = false;
        void reloadThread();
      }
    }
    wasStreaming.current = streamingNow;
  }, [streaming, queryClient, reloadThread]);

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
      // A new thread has to appear in the sidebar while its answer is still arriving.
      void queryClient.invalidateQueries({ queryKey: THREAD_LIST_KEY });
    },
    [model, setLastError, startTurn, queryClient],
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

  /**
   * Switching variants is a server-side move: main records which leaf is active and
   * the thread is re-read, because only main knows what the new active path is.
   */
  const switchVariant = useCallback(
    async (messageId: string) => {
      const current = useChatStore.getState().threadId;
      if (current === null) return;

      setSwitching(true);
      try {
        const result = await setActiveVariant(current, messageId);
        if (!result.ok) {
          setLastError(result.error);
          return;
        }
        await reloadThread();
      } finally {
        setSwitching(false);
      }
    },
    [reloadThread, setLastError],
  );

  const regenerate = useCallback(
    async (messageId: string) => {
      const result = await regenerateMessage(messageId);
      if (!result.ok) {
        setLastError(result.error);
        return;
      }
      refreshAfterStream.current = true;
    },
    [setLastError],
  );

  const onDeleted = useCallback(
    (deletedId: string) => {
      if (useChatStore.getState().threadId === deletedId) selectThread(null);
    },
    [selectThread],
  );

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
  const totals = sumUsage(messages);
  const busy = switching || streaming !== null;

  return (
    <div className="app">
      <header className="bar">
        <span className="mark" />
        <h1>Cleon</h1>
        {totals !== null && <UsageTotal usage={totals} />}
        <span className="tag">D2 · history</span>
        <button
          type="button"
          className="btn btn-small"
          aria-label="Settings"
          title="Settings"
          data-testid="open-settings"
          onClick={() => setView(view === "settings" ? "chat" : "settings")}
        >
          ⚙
        </button>
      </header>

      {view === "settings" ? (
        <SettingsScreen
          model={model}
          onModelChange={setChosenModel}
          onClose={() => setView("chat")}
        />
      ) : (
        <div className="shell">
          <Sidebar
            selectedThreadId={threadId}
            onSelect={selectThread}
            onNewChat={() => selectThread(null)}
            onDeleted={onDeleted}
          />

          <main className="chat">
            <div className="transcript" ref={scroll.ref} onScroll={scroll.onScroll}>
              {(messages.length > 0 || threadId === null) && (
                <MessageList
                  messages={messages}
                  groups={history.groups}
                  busy={busy}
                  onSwitchVariant={(messageId) => void switchVariant(messageId)}
                  onRegenerate={(messageId) => void regenerate(messageId)}
                />
              )}
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
              models={catalog}
              onModelChange={setChosenModel}
              onSend={(text) => void send(text)}
              onStop={() => void stop()}
            />
          </main>
        </div>
      )}

      <Diagnostics />
    </div>
  );
}

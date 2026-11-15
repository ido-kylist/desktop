import type { IpcError } from "@shared/ipc-contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import {
  THREAD_LIST_KEY,
  type ThreadPatch,
  type ThreadSummary,
  useThreadList,
} from "../hooks/use-thread-list";
import { deleteThread, toIpcError, updateThread } from "../lib/ipc";
import { ThreadList } from "./ThreadList";

/**
 * The history sidebar (D2): a search box, a new-chat affordance, and the thread list.
 *
 * Every row action is a contract call followed by an invalidation of the list — never
 * a local splice. The list is the server's answer to a query, and pretending to have
 * applied a change it might have refused is how a list drifts from its database.
 *
 * Failures are stated with the contract's code in one place under the search box:
 * a rename that was refused is not the row's error, it is the action's.
 */

const SEARCH_DEBOUNCE_MS = 250;

export function Sidebar({
  selectedThreadId,
  onSelect,
  onNewChat,
  onDeleted,
}: {
  selectedThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNewChat: () => void;
  onDeleted: (threadId: string) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<IpcError | null>(null);

  const query = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const list = useThreadList(query, includeArchived);
  const queryClient = useQueryClient();

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: THREAD_LIST_KEY });
  };

  const patch = async (threadId: string, fields: ThreadPatch): Promise<void> => {
    setBusyThreadId(threadId);
    setActionError(null);
    const result = await updateThread({ threadId, ...fields });
    setBusyThreadId(null);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    await refresh();
  };

  const remove = async (threadId: string): Promise<void> => {
    setBusyThreadId(threadId);
    setActionError(null);
    const result = await deleteThread(threadId);
    setBusyThreadId(null);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    onDeleted(threadId);
    await refresh();
  };

  const listError = toIpcError(list.error);
  const threads: readonly ThreadSummary[] = list.data?.items ?? [];

  return (
    <aside className="sidebar" aria-label="Threads">
      <div className="sidebar-top">
        <button
          type="button"
          className="btn btn-small new-chat"
          onClick={onNewChat}
          data-testid="new-chat"
        >
          New chat
        </button>
        <input
          type="search"
          className="thread-search"
          aria-label="Search threads"
          placeholder="Search messages…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid="thread-search"
        />
        <label className="archived-toggle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          <span>Archived</span>
        </label>
      </div>

      {actionError !== null && (
        <p className="sidebar-error" role="alert" data-testid="sidebar-error">
          <span className="banner-code">{actionError.code}</span> {actionError.message}
        </p>
      )}

      {listError !== null && (
        <p className="sidebar-error" role="alert" data-testid="thread-list-error">
          <span className="banner-code">{listError.code}</span> {listError.message}
        </p>
      )}

      {list.isPending && <p className="sidebar-note muted">Loading threads…</p>}

      {list.data !== undefined && threads.length === 0 && (
        <p className="sidebar-note muted" data-testid="thread-list-empty">
          {query === "" ? "No threads yet." : "No threads match that search."}
        </p>
      )}

      {threads.length > 0 && (
        // Remounts on a new term or a new archive scope, which resets the scroll
        // position — a narrowed list must not stay scrolled past its own end.
        <ThreadList
          key={`${query}|${String(includeArchived)}`}
          threads={threads}
          selectedThreadId={selectedThreadId}
          busyThreadId={busyThreadId}
          onSelect={onSelect}
          onRename={(threadId, title) => void patch(threadId, { title })}
          onTogglePin={(thread) => void patch(thread.id, { pinned: !thread.pinned })}
          onArchive={(threadId) => void patch(threadId, { archived: true })}
          onDelete={(threadId) => void remove(threadId)}
        />
      )}
    </aside>
  );
}

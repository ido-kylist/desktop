import { useEffect, useRef, useState } from "react";
import type { ThreadSummary } from "../hooks/use-thread-list";
import { relativeTime } from "../lib/format";
import { parseSnippet } from "../lib/snippet";

/**
 * One thread in the list. The height is fixed by the container (the list is windowed
 * on a constant row height), so every state of this row — resting, renaming,
 * confirming a delete — has to fit the same box; that is why the actions live on
 * their own line rather than in a popover.
 *
 * Delete asks in place. `window.confirm` would block the whole renderer, cannot be
 * styled or reached from a test without a dialog handler, and says nothing about
 * which thread is about to go.
 */
export function ThreadRow({
  thread,
  selected,
  busy,
  onSelect,
  onRename,
  onTogglePin,
  onArchive,
  onDelete,
}: {
  thread: ThreadSummary;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const [confirming, setConfirming] = useState(false);
  const renameInput = useRef<HTMLInputElement | null>(null);

  // The field only exists because the user asked to rename this row, so it takes the
  // caret on the next paint; typing without a second click is the point of inline edit.
  useEffect(() => {
    if (editing) renameInput.current?.focus();
  }, [editing]);

  const beginRename = (): void => {
    setDraft(thread.title);
    setConfirming(false);
    setEditing(true);
  };

  const commitRename = (): void => {
    const title = draft.trim();
    setEditing(false);
    if (title === "" || title === thread.title) return;
    onRename(title);
  };

  return (
    <li
      className="thread-row"
      data-testid="thread-row"
      aria-current={selected ? "true" : undefined}
    >
      {editing ? (
        <form
          className="thread-rename"
          onSubmit={(event) => {
            event.preventDefault();
            commitRename();
          }}
        >
          <input
            ref={renameInput}
            className="thread-rename-input"
            aria-label="Thread title"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
          />
          <button type="submit" className="link-btn" disabled={busy}>
            Save
          </button>
          <button type="button" className="link-btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="thread-open" onClick={onSelect}>
          <span className="thread-title-line">
            {thread.pinned && <span className="thread-pin">pinned</span>}
            <span className="thread-title">{thread.title}</span>
          </span>
          <span className="thread-meta">
            {relativeTime(thread.updatedAt)} · {thread.messageCount}{" "}
            {thread.messageCount === 1 ? "message" : "messages"}
          </span>
          {thread.snippet !== null && (
            <span className="thread-snippet">
              {parseSnippet(thread.snippet).map((segment, index) =>
                segment.match ? (
                  <mark key={`${index}-${segment.text}`}>{segment.text}</mark>
                ) : (
                  <span key={`${index}-${segment.text}`}>{segment.text}</span>
                ),
              )}
            </span>
          )}
        </button>
      )}

      <div className="thread-actions">
        {confirming ? (
          <>
            <span className="thread-confirm">Delete this thread?</span>
            <button
              type="button"
              className="link-btn link-danger"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              Delete
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {!editing && (
              <button type="button" className="link-btn" disabled={busy} onClick={beginRename}>
                Rename
              </button>
            )}
            <button type="button" className="link-btn" disabled={busy} onClick={onTogglePin}>
              {thread.pinned ? "Unpin" : "Pin"}
            </button>
            <button type="button" className="link-btn" disabled={busy} onClick={onArchive}>
              Archive
            </button>
            <button
              type="button"
              className="link-btn link-danger"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setConfirming(true);
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
}

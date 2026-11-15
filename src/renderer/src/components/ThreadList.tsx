import { useEffect, useRef, useState } from "react";
import type { ThreadSummary } from "../hooks/use-thread-list";
import { computeWindow } from "../lib/window";
import { ThreadRow } from "./ThreadRow";

/**
 * The windowed thread list: fixed row height, only the visible slice plus overscan is
 * in the DOM, and a spacer of the full height keeps the scrollbar honest.
 *
 * The maths lives in `computeWindow` so it can be tested without a DOM; this component
 * only measures `clientHeight` and `scrollTop` and paints the result. ResizeObserver
 * rather than a window resize listener, because the sidebar can be re-laid out without
 * the window changing size.
 */

/** Must match `.thread-row`'s height in `styles.css`; the windowing assumes it. */
export const THREAD_ROW_HEIGHT = 96;

const OVERSCAN = 4;

export function ThreadList({
  threads,
  selectedThreadId,
  busyThreadId,
  onSelect,
  onRename,
  onTogglePin,
  onArchive,
  onDelete,
}: {
  threads: readonly ThreadSummary[];
  selectedThreadId: string | null;
  busyThreadId: string | null;
  onSelect: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
  onTogglePin: (thread: ThreadSummary) => void;
  onArchive: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;

    const measure = (): void => setViewportHeight(node.clientHeight);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const range = computeWindow({
    itemCount: threads.length,
    rowHeight: THREAD_ROW_HEIGHT,
    viewportHeight,
    scrollTop,
    overscan: OVERSCAN,
  });
  const visible = threads.slice(range.start, range.end);

  return (
    <div
      className="thread-scroll"
      data-testid="thread-list"
      ref={scroller}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="thread-spacer" style={{ height: range.totalHeight }}>
        <ul className="thread-window" style={{ transform: `translateY(${range.offsetTop}px)` }}>
          {visible.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              selected={thread.id === selectedThreadId}
              busy={thread.id === busyThreadId}
              onSelect={() => onSelect(thread.id)}
              onRename={(title) => onRename(thread.id, title)}
              onTogglePin={() => onTogglePin(thread)}
              onArchive={() => onArchive(thread.id)}
              onDelete={() => onDelete(thread.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

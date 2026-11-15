/**
 * The windowing math for the sidebar's thread list.
 *
 * Deliberately pure: the component measures two numbers (`clientHeight` and
 * `scrollTop`) and hands them here, so the geometry can be tested without a DOM.
 *
 * The scroll offset is clamped against the real scroll range before any index is
 * computed. A browser does not normally report a `scrollTop` past
 * `totalHeight - viewportHeight`, but a list that shrank under the scroll position
 * reports one, and clamping there is what keeps the tail on screen instead of a
 * blank window.
 */

export interface WindowSpec {
  itemCount: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan: number;
}

export interface WindowRange {
  /** First rendered index. */
  start: number;
  /** Last rendered index, exclusive. */
  end: number;
  /** How far the rendered window sits from the top of the list, in pixels. */
  offsetTop: number;
  /** The full list height, so the scrollbar stays honest. */
  totalHeight: number;
}

const EMPTY: WindowRange = { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function computeWindow(spec: WindowSpec): WindowRange {
  const itemCount = Math.max(0, Math.floor(finite(spec.itemCount, 0)));
  const overscan = Math.max(0, Math.floor(finite(spec.overscan, 0)));

  // A non-positive row height cannot describe a row; rendering nothing is the only
  // honest answer, and it keeps the divisions below defined.
  if (itemCount === 0 || !(spec.rowHeight > 0)) return EMPTY;

  const totalHeight = itemCount * spec.rowHeight;
  const viewportHeight = Math.max(0, finite(spec.viewportHeight, 0));
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const scrollTop = Math.min(Math.max(0, finite(spec.scrollTop, 0)), maxScrollTop);

  const firstVisible = Math.floor(scrollTop / spec.rowHeight);
  // Exclusive: the row that straddles the bottom edge is visible and must be drawn.
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / spec.rowHeight);

  const start = Math.min(Math.max(0, firstVisible - overscan), itemCount - 1);
  // `lastVisible` can be 0 when the viewport has not been measured yet; the window
  // still has to contain the row under the scroll position.
  const end = Math.min(Math.max(lastVisible + overscan, start + 1), itemCount);

  return { start, end, offsetTop: start * spec.rowHeight, totalHeight };
}

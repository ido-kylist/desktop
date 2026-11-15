import { describe, expect, it } from "vitest";
import { computeWindow } from "../../src/renderer/src/lib/window.js";

/**
 * The windowing maths, without a DOM.
 *
 * The component measures `clientHeight` and `scrollTop` and hands them here, so every
 * case that matters — an empty list, the first page, a scrolled middle, a scroll past
 * the end, a list shorter than its viewport — is decided by this function and can be
 * asserted exactly.
 */

const ROW = 50;
const OVERSCAN = 2;

function window_(spec: {
  itemCount: number;
  viewportHeight: number;
  scrollTop: number;
  rowHeight?: number;
  overscan?: number;
}) {
  return computeWindow({
    itemCount: spec.itemCount,
    rowHeight: spec.rowHeight ?? ROW,
    viewportHeight: spec.viewportHeight,
    scrollTop: spec.scrollTop,
    overscan: spec.overscan ?? OVERSCAN,
  });
}

describe("computeWindow: degenerate inputs", () => {
  it("renders nothing for an empty list", () => {
    expect(window_({ itemCount: 0, viewportHeight: 400, scrollTop: 0 })).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
  });

  it("renders nothing for an empty list even when scrolled", () => {
    expect(window_({ itemCount: 0, viewportHeight: 400, scrollTop: 900 })).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
  });

  it("renders nothing when the row height cannot describe a row", () => {
    expect(window_({ itemCount: 10, viewportHeight: 400, scrollTop: 0, rowHeight: 0 })).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
    expect(window_({ itemCount: 10, viewportHeight: 400, scrollTop: 0, rowHeight: -50 })).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
  });

  it("floors a fractional item count instead of inventing a row", () => {
    expect(window_({ itemCount: 3.9, viewportHeight: 500, scrollTop: 0 })).toEqual({
      start: 0,
      end: 3,
      offsetTop: 0,
      totalHeight: 150,
    });
  });
});

describe("computeWindow: the top of the list", () => {
  it("renders the first page plus overscan on both sides", () => {
    // 100 rows of 50px, a 300px viewport: rows 0..5 are visible, overscan 2 pulls the
    // window to 0..7 (there is nothing above row 0 to overscan into).
    expect(window_({ itemCount: 100, viewportHeight: 300, scrollTop: 0 })).toEqual({
      start: 0,
      end: 8,
      offsetTop: 0,
      totalHeight: 5000,
    });
  });

  it("includes the row that straddles the bottom edge", () => {
    // 300 / 50 is exact, but a 310px viewport shows part of row 6, so it must be drawn.
    expect(window_({ itemCount: 100, viewportHeight: 310, scrollTop: 0 }).end).toBe(9);
  });

  it("treats a negative scroll offset as the top", () => {
    expect(window_({ itemCount: 100, viewportHeight: 300, scrollTop: -40 })).toEqual(
      window_({ itemCount: 100, viewportHeight: 300, scrollTop: 0 }),
    );
  });

  it("renders at least one row when the viewport has not been measured yet", () => {
    const range = window_({ itemCount: 10, viewportHeight: 0, scrollTop: 0 });
    expect(range.start).toBe(0);
    expect(range.end).toBe(2);
    expect(range.totalHeight).toBe(500);
  });
});

describe("computeWindow: a scrolled middle", () => {
  it("windows around the scroll position and reports the spacer offset", () => {
    // scrollTop 1000 is row 20; 300px more reaches row 26; overscan 2 → 18..27.
    expect(window_({ itemCount: 100, viewportHeight: 300, scrollTop: 1000 })).toEqual({
      start: 18,
      end: 28,
      offsetTop: 900,
      totalHeight: 5000,
    });
  });

  it("moves by exactly one row when the scroll advances by one row", () => {
    const before = window_({ itemCount: 100, viewportHeight: 300, scrollTop: 1000 });
    const after = window_({ itemCount: 100, viewportHeight: 300, scrollTop: 1050 });
    expect(after.start).toBe(before.start + 1);
    expect(after.end).toBe(before.end + 1);
    expect(after.offsetTop).toBe(before.offsetTop + ROW);
  });
});

describe("computeWindow: the end of the list", () => {
  it("never renders past the last row", () => {
    // Max scroll for 100 rows in 300px is 4700: rows 94..99 visible, 92..100 with
    // overscan — the tail is clamped, not padded with blanks.
    expect(window_({ itemCount: 100, viewportHeight: 300, scrollTop: 4700 })).toEqual({
      start: 92,
      end: 100,
      offsetTop: 4600,
      totalHeight: 5000,
    });
  });

  it("clamps a scroll position past the end onto the last page", () => {
    const range = window_({ itemCount: 100, viewportHeight: 300, scrollTop: 99_999 });
    expect(range.end).toBe(100);
    expect(range.start).toBe(92);
  });

  it("keeps the whole list on screen when it is shorter than the viewport", () => {
    expect(window_({ itemCount: 3, viewportHeight: 500, scrollTop: 0 })).toEqual({
      start: 0,
      end: 3,
      offsetTop: 0,
      totalHeight: 150,
    });
    // Nothing to scroll, so any offset collapses to the same window.
    expect(window_({ itemCount: 3, viewportHeight: 500, scrollTop: 400 })).toEqual({
      start: 0,
      end: 3,
      offsetTop: 0,
      totalHeight: 150,
    });
  });

  it("renders the last row when only it is left", () => {
    const range = window_({ itemCount: 1, viewportHeight: 0, scrollTop: 0 });
    expect(range).toEqual({ start: 0, end: 1, offsetTop: 0, totalHeight: 50 });
  });
});

describe("computeWindow: invariants", () => {
  it("always returns a non-empty, in-bounds range for a non-empty list", () => {
    for (const scrollTop of [0, 1, 49, 50, 51, 1000, 4700, 9999, -10]) {
      for (const viewportHeight of [0, 1, 300, 111]) {
        const range = window_({ itemCount: 100, viewportHeight, scrollTop });
        expect(range.start).toBeGreaterThanOrEqual(0);
        expect(range.start).toBeLessThan(100);
        expect(range.end).toBeGreaterThan(range.start);
        expect(range.end).toBeLessThanOrEqual(100);
        expect(range.offsetTop).toBe(range.start * ROW);
        expect(range.totalHeight).toBe(100 * ROW);
      }
    }
  });

  it("never renders more rows than the visible band plus overscan on both sides", () => {
    const viewportHeight = 300;
    const range = window_({ itemCount: 100, viewportHeight, scrollTop: 1000 });
    const visibleRows = Math.ceil(viewportHeight / ROW);
    expect(range.end - range.start).toBeLessThanOrEqual(visibleRows + 2 * OVERSCAN);
  });

  it("falls back to the top for a scroll offset that is not a number", () => {
    expect(window_({ itemCount: 100, viewportHeight: 300, scrollTop: Number.NaN })).toEqual(
      window_({ itemCount: 100, viewportHeight: 300, scrollTop: 0 }),
    );
  });

  it("treats a negative overscan as none", () => {
    expect(window_({ itemCount: 100, viewportHeight: 300, scrollTop: 0, overscan: -5 })).toEqual({
      start: 0,
      end: 6,
      offsetTop: 0,
      totalHeight: 5000,
    });
  });
});

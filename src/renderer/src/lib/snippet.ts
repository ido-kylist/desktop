/**
 * FTS5 writes its match markers as `[` and `]` inside the snippet. They are syntax,
 * not content: the row renders them as highlighting and never shows the brackets.
 *
 * Anything that does not form a complete pair stays literal text, so a snippet cut
 * mid-match by the server's own windowing is displayed rather than swallowed.
 */

export interface SnippetSegment {
  text: string;
  match: boolean;
}

const MARKER = /\[([^\]]*)\]/g;

export function parseSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let cursor = 0;

  for (const found of snippet.matchAll(MARKER)) {
    const start = found.index;
    if (start === undefined) continue;
    if (start > cursor) segments.push({ text: snippet.slice(cursor, start), match: false });
    segments.push({ text: found[1] ?? "", match: true });
    cursor = start + found[0].length;
  }

  if (cursor < snippet.length) segments.push({ text: snippet.slice(cursor), match: false });
  return segments;
}

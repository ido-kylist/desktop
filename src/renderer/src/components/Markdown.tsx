import { renderMarkdown } from "../lib/markdown";

/**
 * The only place the transcript's Markdown becomes elements. It has no HTML path:
 * `renderMarkdown` builds React nodes from a parsed tree, so model output is text.
 *
 * `live` marks the one answer that is still arriving. The polite region is on the
 * message body, not on the transcript: a live region around the whole list would
 * re-announce every earlier turn on each token, and a region that is only polite while
 * a generation is live says nothing at all when a thread is restored.
 *
 * `aria-atomic="false"` so a delta is read on its own rather than the whole answer
 * being re-read from the first word twenty times a second.
 */
export function Markdown({
  text,
  live = false,
}: {
  text: string;
  live?: boolean;
}): React.JSX.Element {
  return (
    <div className="md" {...(live ? { "aria-live": "polite" as const, "aria-atomic": false } : {})}>
      {renderMarkdown(text)}
    </div>
  );
}

import { renderMarkdown } from "../lib/markdown";

/**
 * The only place the transcript's Markdown becomes elements. It has no HTML path:
 * `renderMarkdown` builds React nodes from a parsed tree, so model output is text.
 */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  return <div className="md">{renderMarkdown(text)}</div>;
}

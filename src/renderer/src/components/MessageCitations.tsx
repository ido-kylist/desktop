import type { Citation, IpcError } from "@shared/ipc-contract";
import { useCallback, useState } from "react";
import { readKnowledgeChunk } from "../lib/ipc";

/**
 * The sources an answer used, under the answer (D8).
 *
 * A chip is a pointer, not a copy: the message row stores four fields per citation (id,
 * document id, title, ordinal) and the text is fetched when the user expands one. That is
 * why an old answer still opens correctly after the app restarts — and why a chunk that has
 * since been deleted collapses to a message instead of a blank panel.
 *
 * Expanding is per chip rather than per message: a user checking "was that number from page
 * two or page five" wants one source open, not five.
 *
 * The number on the chip is the marker the answer was told to cite (`[1]`, `[2]`, …), which
 * is the only thing that connects a sentence in the answer to a row here.
 */
export function MessageCitations({
  citations,
}: {
  citations: readonly Citation[];
}): React.JSX.Element | null {
  const [openId, setOpenId] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<IpcError | null>(null);
  const [loading, setLoading] = useState(false);

  const open = useCallback(
    async (citation: Citation) => {
      // A second click on the open chip closes it; nothing else changes.
      if (openId === citation.chunkId) {
        setOpenId(null);
        setText(null);
        setError(null);
        return;
      }

      setOpenId(citation.chunkId);
      setText(null);
      setError(null);
      setLoading(true);
      const result = await readKnowledgeChunk(citation.chunkId);
      setLoading(false);

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setText(result.data.chunk.text);
    },
    [openId],
  );

  if (citations.length === 0) return null;

  const expanded = citations.find((citation) => citation.chunkId === openId) ?? null;

  return (
    <div className="citations" data-testid="citations">
      <span className="citations-label">Sources</span>
      <ul className="citation-chips">
        {citations.map((citation, index) => (
          <li key={citation.chunkId}>
            <button
              type="button"
              className="citation-chip"
              aria-expanded={citation.chunkId === openId}
              onClick={() => void open(citation)}
              data-testid="citation-chip"
              title={`${citation.documentTitle} · chunk ${citation.ordinal + 1}`}
            >
              <span className="citation-marker">[{index + 1}]</span>
              <span className="citation-title">{citation.documentTitle}</span>
            </button>
          </li>
        ))}
      </ul>

      {expanded !== null && (
        <div className="citation-source" data-testid="citation-source">
          <div className="citation-source-head">
            <span className="citation-source-name">
              {expanded.documentTitle} · chunk {expanded.ordinal + 1}
            </span>
            <button
              type="button"
              className="link-btn"
              onClick={() => setOpenId(null)}
              data-testid="citation-source-close"
            >
              Close
            </button>
          </div>
          {loading && <p className="muted">Loading the source…</p>}
          {error !== null && (
            <p className="sidebar-error" role="alert" data-testid="citation-source-error">
              <span className="banner-code">{error.code}</span> {error.message}
            </p>
          )}
          {text !== null && <pre className="citation-text">{text}</pre>}
        </div>
      )}
    </div>
  );
}

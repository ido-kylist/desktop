import type { IpcError, KnowledgeHit } from "@shared/ipc-contract";
import { useQueryClient } from "@tanstack/react-query";
import type { ChangeEvent } from "react";
import { useRef, useState } from "react";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import {
  KNOWLEDGE_LIST_KEY,
  type KnowledgeDocumentView,
  useKnowledgeDocuments,
} from "../hooks/use-knowledge";
import {
  attachmentPathsFromFiles,
  describeAttachmentFailure,
  formatBytes,
  unresolvedPathsProblem,
} from "../lib/attachments";
import { buildCatalog, type Catalog } from "../lib/catalogs";
import { isProviderUnreachable, OFFLINE_TITLE } from "../lib/connectivity";
import {
  addKnowledgeDocuments,
  deleteKnowledgeDocument,
  searchKnowledge,
  toIpcError,
} from "../lib/ipc";

/**
 * The extensions the picker offers, mirrored from main's text table.
 *
 * A hint for the dialog only: main decides what it accepts, and a file the dialog offered but
 * main refused is refused with a reason the panel shows. The duplication is deliberate — the
 * renderer cannot import main — and it is the same arrangement `lib/attachments.ts` has.
 */
const ACCEPT_ATTRIBUTE = ".txt,.md";

/**
 * The knowledge base (D8): what has been indexed, and what a query would retrieve from it.
 *
 * Three states it keeps apart, because they have three different fixes:
 *
 *  - **empty** — nothing has been added; the panel says so and offers the picker.
 *  - **failed** — the read or the add did not complete; the panel shows the code and keeps the
 *    documents it already knew about, so a transient failure does not read as "your corpus is
 *    gone".
 *  - **ready** — one row per document, with its chunk count. The count is the number of
 *    vectors search will scan, which is the one number that explains why a search is slow.
 *
 * The search preview shows scores, deliberately: a ranking whose numbers are hidden is a
 * ranking nobody can debug, and a "0.31 is barely a match" read is the only thing that makes
 * a bad retrieval diagnosable from the UI.
 *
 * Files are copied and read by main; the renderer only hands over paths. That is the same
 * rule attachments follow, for the same reason: the renderer does not touch the file system.
 */
export function KnowledgePanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const documents = useKnowledgeDocuments();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState<"add" | "delete" | "search" | null>(null);
  const [error, setError] = useState<IpcError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  useDialogFocus(panel, onClose);

  const catalog: Catalog<KnowledgeDocumentView> = buildCatalog({
    loading: documents.isPending,
    result: documents.data?.items,
    error: toIpcError(documents.error),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: KNOWLEDGE_LIST_KEY });
  };

  const addPaths = async (paths: readonly string[]): Promise<void> => {
    if (paths.length === 0 || busy !== null) return;

    setBusy("add");
    setError(null);
    setProblem(null);
    const result = await addKnowledgeDocuments(paths);
    setBusy(null);
    if (!result.ok) {
      // A refusal main explained in the attachment vocabulary (too large, duplicate, not
      // text) is shown in those words; anything else is shown with its code.
      const described = describeAddFailure(result.error);
      if (described === null) setError(result.error);
      else setProblem(described);
      return;
    }
    await refresh();
  };

  const onPicked = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    // Cleared so picking the same file twice still fires a change.
    event.target.value = "";
    if (files.length === 0) return;

    const { paths, unresolved } = attachmentPathsFromFiles(files);
    if (unresolved.length > 0) {
      setProblem(unresolvedPathsProblem(unresolved.length).detail);
      return;
    }
    void addPaths(paths);
  };

  const remove = async (document: KnowledgeDocumentView): Promise<void> => {
    if (busy !== null) return;

    setBusy("delete");
    setError(null);
    setProblem(null);
    const result = await deleteKnowledgeDocument(document.id);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // A deleted document can be in the preview below; its chunks no longer exist.
    setHits(null);
    await refresh();
  };

  const search = async (): Promise<void> => {
    const text = query.trim();
    if (text === "" || busy !== null) return;

    setBusy("search");
    setError(null);
    setProblem(null);
    const result = await searchKnowledge({ query: text, limit: 5 });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setHits(result.data.chunks);
  };

  return (
    <div className="library-backdrop" data-testid="kb-panel">
      <section
        className="library kb"
        role="dialog"
        aria-modal="true"
        aria-label="Knowledge base"
        ref={panel}
        tabIndex={-1}
      >
        <div className="library-head">
          <h2>Knowledge</h2>
          <span className="mcp-kicker">indexed locally · searched on this machine</span>
          <button
            type="button"
            className="btn btn-small"
            aria-label="Refresh documents"
            title="Refresh documents"
            onClick={() => void refresh()}
            data-testid="kb-refresh"
          >
            ↻
          </button>
          <button
            type="button"
            className="btn btn-small"
            aria-label="Close knowledge"
            onClick={onClose}
            data-testid="kb-close"
          >
            ✕
          </button>
        </div>

        <div className="library-form">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept={ACCEPT_ATTRIBUTE}
            data-testid="kb-file-input"
            onChange={onPicked}
          />
          <div className="library-form-actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={busy !== null}
              onClick={() => picker.current?.click()}
              data-testid="kb-add"
            >
              {busy === "add" ? "Indexing…" : "Add documents"}
            </button>
            <span className="library-count">
              Text files only (.txt, .md). PDFs need text extraction, which this build does not
              have.
            </span>
          </div>
        </div>

        {problem !== null && (
          <p className="sidebar-error" role="alert" data-testid="kb-problem">
            {problem}
          </p>
        )}

        {error !== null && (
          <p
            className="sidebar-error"
            role="alert"
            data-testid="kb-error"
            data-state={isProviderUnreachable(error) ? "offline" : "failed"}
          >
            {isProviderUnreachable(error) && (
              <strong className="offline-title">{OFFLINE_TITLE}</strong>
            )}
            <span className="banner-code">{error.code}</span> {error.message}
          </p>
        )}

        {catalog.state === "loading" && <p className="sidebar-note muted">Loading documents…</p>}

        {catalog.state === "error" && (
          <p className="sidebar-error" role="alert" data-testid="kb-list-error">
            <span className="banner-code">{catalog.error.code}</span> {catalog.error.message}
          </p>
        )}

        {catalog.state === "empty" && (
          <p className="sidebar-note muted" data-testid="kb-list-empty">
            No documents yet. Add a text file to search it from a message.
          </p>
        )}

        {catalog.state === "ready" && (
          <ul className="library-list" data-testid="kb-document-list">
            {catalog.items.map((document) => (
              <li className="library-row" key={document.id} data-testid="kb-document">
                <div className="library-row-main">
                  <span className="library-row-title">{document.title}</span>
                  <span
                    className="library-row-meta"
                    data-testid="kb-document-chunks"
                    data-chunks={document.chunkCount}
                  >
                    {document.chunkCount} {document.chunkCount === 1 ? "chunk" : "chunks"} ·{" "}
                    {formatBytes(document.bytes)}
                  </span>
                  <span className="library-row-body mono">{document.sourcePath}</span>
                </div>
                <div className="library-row-actions">
                  <button
                    type="button"
                    className="btn btn-small btn-stop"
                    disabled={busy !== null}
                    onClick={() => void remove(document)}
                    data-testid="kb-document-delete"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3 className="mcp-records-title">Search preview</h3>
        <form
          className="library-form"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label className="library-field">
            <span>Query</span>
            <input
              type="text"
              value={query}
              maxLength={2000}
              placeholder="what would this corpus return?"
              onChange={(event) => setQuery(event.target.value)}
              data-testid="kb-search-input"
            />
          </label>
          <div className="library-form-actions">
            <button
              type="submit"
              className="btn btn-small"
              disabled={busy !== null || query.trim() === ""}
              data-testid="kb-search-run"
            >
              {busy === "search" ? "Searching…" : "Search"}
            </button>
          </div>
        </form>

        {hits !== null && hits.length === 0 && (
          <p className="sidebar-note muted" data-testid="kb-search-empty">
            Nothing matched. An empty corpus and a query with no shared words look the same here.
          </p>
        )}

        {hits !== null && hits.length > 0 && (
          <ul className="kb-hits" data-testid="kb-search-results">
            {hits.map((hit) => (
              <li className="kb-hit" key={hit.chunkId} data-testid="kb-search-hit">
                <div className="kb-hit-head">
                  <span className="kb-hit-source">
                    {hit.documentTitle} · chunk {hit.ordinal + 1}
                  </span>
                  <span className="kb-hit-score mono" data-testid="kb-search-score">
                    {hit.score.toFixed(3)}
                  </span>
                </div>
                <p className="kb-hit-text">{hit.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The sentence for a refusal this build knows how to explain, or null.
 *
 * The reasons come from main's `details.reason`, the same open record attachments use. A
 * reason this build does not know is left to the generic error banner rather than rendered
 * as if it were a sentence.
 */
function describeAddFailure(error: IpcError): string | null {
  const reason = error.details?.reason;
  if (typeof reason !== "string") return null;

  if (reason === "not_readable_text") return error.message;
  if (reason === "empty_document") return error.message;
  if (reason === "already_indexed") {
    return "That file is already indexed. Remove it first to index its new contents.";
  }
  if (reason === "too_large" || reason === "too_many" || reason === "unsupported_type") {
    return describeAttachmentFailure(error).detail;
  }
  return null;
}

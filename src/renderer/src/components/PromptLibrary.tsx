import type { IpcError } from "@shared/ipc-contract";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { useModelCatalog } from "../hooks/use-model-catalog";
import { usePrompts } from "../hooks/use-prompts";
import { buildCatalog, type Catalog } from "../lib/catalogs";
import { createPrompt, deletePrompt, toIpcError, updatePrompt } from "../lib/ipc";
import { DEFAULT_MODEL, resolveDefaultModel } from "../lib/models";
import { AssistantPanel } from "./AssistantPanel";

/**
 * The prompt library (D6): search, insert, create, edit, delete — and, behind the second
 * tab, the assistant manager.
 *
 * Insertion is a callback into the composer rather than a channel: the text belongs in
 * the message being written, and main has no business knowing what is in a textarea
 * before it is sent.
 *
 * Search is debounced and lives on the server (SQL over title and body), so the list on
 * screen is always what the database matched. A failed read is an error with a code, an
 * empty library says it is empty, and the two are never the same picture.
 */

const SEARCH_DEBOUNCE_MS = 250;

type Tab = "prompts" | "assistants";

export function PromptLibrary({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (text: string) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("prompts");
  const panel = useRef<HTMLElement | null>(null);
  useDialogFocus(panel, onClose);

  return (
    <div className="library-backdrop" data-testid="prompt-library">
      <section
        className="library"
        role="dialog"
        aria-modal="true"
        aria-label="Prompt library"
        ref={panel}
        tabIndex={-1}
      >
        <div className="library-head">
          <h2>Library</h2>
          <div className="library-tabs" role="tablist" aria-label="Library sections">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "prompts"}
              className="library-tab"
              onClick={() => setTab("prompts")}
              data-testid="tab-prompts"
            >
              Prompts
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "assistants"}
              className="library-tab"
              onClick={() => setTab("assistants")}
              data-testid="tab-assistants"
            >
              Assistants
            </button>
          </div>
          <button
            type="button"
            className="btn btn-small"
            aria-label="Close library"
            onClick={onClose}
            data-testid="library-close"
          >
            ✕
          </button>
        </div>

        {tab === "prompts" ? <PromptsTab onInsert={onInsert} /> : <AssistantsTab />}
      </section>
    </div>
  );
}

/** The assistant tab needs the current model, which only the catalogue knows. */
function AssistantsTab(): React.JSX.Element {
  const { catalog } = useModelCatalog();
  const model =
    resolveDefaultModel(null, catalog.state === "ready" ? catalog.options : []) ?? DEFAULT_MODEL;
  return <AssistantPanel model={model} />;
}

function PromptsTab({ onInsert }: { onInsert: (text: string) => void }): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);

  const query = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const prompts = usePrompts(query);
  const queryClient = useQueryClient();

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["prompts.list"] });
  };

  const create = async (): Promise<void> => {
    if (title.trim() === "" || body.trim() === "" || busy) return;

    setBusy(true);
    setError(null);
    const result = await createPrompt({ title: title.trim(), body });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTitle("");
    setBody("");
    await refresh();
  };

  const saveEdit = async (promptId: string): Promise<void> => {
    if (editTitle.trim() === "" || editBody.trim() === "" || busy) return;

    setBusy(true);
    setError(null);
    const result = await updatePrompt({
      promptId,
      title: editTitle.trim(),
      body: editBody,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEditingId(null);
    await refresh();
  };

  const remove = async (promptId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await deletePrompt(promptId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (editingId === promptId) setEditingId(null);
    await refresh();
  };

  const catalog: Catalog<{ id: string; title: string; body: string }> = buildCatalog({
    loading: prompts.isPending,
    result: prompts.data?.items,
    error: toIpcError(prompts.error),
  });

  return (
    <div className="prompt-tab" data-testid="prompt-tab">
      <div className="library-toolbar">
        <input
          type="search"
          className="thread-search"
          aria-label="Search prompts"
          placeholder="Search prompts…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid="prompt-search"
        />
        {catalog.state === "ready" && (
          <span className="library-count" data-testid="prompt-count">
            {prompts.data?.total ?? 0}
          </span>
        )}
      </div>

      <form
        className="library-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="library-form-row">
          <label className="library-field">
            <span>Title</span>
            <input
              type="text"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              data-testid="prompt-title"
            />
          </label>
        </div>
        <label className="library-field">
          <span>Body</span>
          <textarea
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            data-testid="prompt-body"
          />
        </label>
        <div className="library-form-actions">
          <button
            type="submit"
            className="btn btn-small"
            disabled={busy || title.trim() === "" || body.trim() === ""}
            data-testid="prompt-create"
          >
            Add prompt
          </button>
        </div>
      </form>

      {error !== null && (
        <p className="sidebar-error" role="alert" data-testid="prompt-error">
          <span className="banner-code">{error.code}</span> {error.message}
        </p>
      )}

      {catalog.state === "loading" && <p className="sidebar-note muted">Loading prompts…</p>}

      {catalog.state === "error" && (
        <p className="sidebar-error" role="alert" data-testid="prompt-list-error">
          <span className="banner-code">{catalog.error.code}</span> {catalog.error.message}
        </p>
      )}

      {catalog.state === "empty" && (
        <p className="sidebar-note muted" data-testid="prompt-list-empty">
          {query === "" ? "No prompts yet." : "No prompts match that search."}
        </p>
      )}

      {catalog.state === "ready" && (
        <ul className="library-list" data-testid="prompt-list">
          {catalog.items.map((prompt) => (
            <li className="library-row" key={prompt.id}>
              {editingId === prompt.id ? (
                <div className="library-edit">
                  <label className="library-field">
                    <span>Title</span>
                    <input
                      type="text"
                      value={editTitle}
                      maxLength={200}
                      onChange={(event) => setEditTitle(event.target.value)}
                      data-testid="prompt-edit-title"
                    />
                  </label>
                  <label className="library-field">
                    <span>Body</span>
                    <textarea
                      rows={4}
                      value={editBody}
                      onChange={(event) => setEditBody(event.target.value)}
                      data-testid="prompt-edit-body"
                    />
                  </label>
                  <div className="library-row-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => void saveEdit(prompt.id)}
                      data-testid="prompt-edit-save"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="library-row-main">
                    <span className="library-row-title">{prompt.title}</span>
                    <span className="library-row-body">{prompt.body}</span>
                  </div>
                  <div className="library-row-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => onInsert(prompt.body)}
                      data-testid="prompt-insert"
                    >
                      Insert
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        setEditingId(prompt.id);
                        setEditTitle(prompt.title);
                        setEditBody(prompt.body);
                      }}
                      data-testid="prompt-edit"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-stop"
                      disabled={busy}
                      onClick={() => void remove(prompt.id)}
                      data-testid="prompt-delete"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

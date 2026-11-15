import type { IpcError, ResponseOf } from "@shared/ipc-contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ASSISTANT_LIST_KEY, useAssistants } from "../hooks/use-assistants";
import { buildCatalog, type Catalog } from "../lib/catalogs";
import { createAssistant, deleteAssistant, toIpcError, updateAssistant } from "../lib/ipc";

/**
 * The assistant manager (D6), as a tab of the prompt library.
 *
 * The brief only asked for a picker in the composer, but a picker with no way to put
 * anything in it is a dead control: these are the channels the contract declares
 * (`assistants.create/update/delete`) with the one surface that calls them. The same
 * four read states as every other list, for the same reason.
 *
 * Editing loads the row into the form rather than editing in place: an assistant is four
 * related fields, and a half-edited prompt is worse than a form the user can cancel.
 */

export type AssistantSummary = ResponseOf<"assistants.list">["items"][number];

/** The form's own shape. Temperature is a string because that is what a number input gives. */
interface Draft {
  name: string;
  model: string;
  systemPrompt: string;
  temperature: string;
}

const EMPTY_DRAFT: Draft = { name: "", model: "", systemPrompt: "", temperature: "0.7" };

function draftOf(assistant: AssistantSummary): Draft {
  return {
    name: assistant.name,
    model: assistant.model,
    systemPrompt: assistant.systemPrompt,
    temperature: String(assistant.temperature),
  };
}

export function AssistantPanel({ model }: { model: string }): React.JSX.Element {
  const assistants = useAssistants();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);

  const points = (value: string): number => Number(value);
  const invalidTemperature = (value: string): boolean => {
    const parsed = points(value);
    return !Number.isFinite(parsed) || parsed < 0 || parsed > 2;
  };
  const canSave =
    draft.name.trim() !== "" && draft.model.trim() !== "" && !invalidTemperature(draft.temperature);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ASSISTANT_LIST_KEY });
  };

  const reset = (): void => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  };

  const save = async (): Promise<void> => {
    if (!canSave || busy) return;

    setBusy(true);
    setError(null);

    const fields = {
      name: draft.name.trim(),
      model: draft.model.trim(),
      systemPrompt: draft.systemPrompt,
      temperature: points(draft.temperature),
    };

    const result =
      editingId === null
        ? await createAssistant(fields)
        : await updateAssistant({ assistantId: editingId, ...fields });

    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reset();
    await refresh();
  };

  const remove = async (assistantId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await deleteAssistant(assistantId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The form was editing the row that just went away; leaving it filled would invite
    // a save that can only fail with NOT_FOUND.
    if (editingId === assistantId) reset();
    await refresh();
  };

  const catalog: Catalog<AssistantSummary> = buildCatalog({
    loading: assistants.isPending,
    result: assistants.data?.items,
    error: toIpcError(assistants.error),
  });

  return (
    <div className="assistant-panel" data-testid="assistant-panel">
      <form
        className="library-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="library-form-row">
          <label className="library-field">
            <span>Name</span>
            <input
              type="text"
              value={draft.name}
              maxLength={80}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              data-testid="assistant-name"
            />
          </label>
          <label className="library-field">
            <span>Model</span>
            <input
              type="text"
              value={draft.model}
              maxLength={200}
              // The catalogue's current model is the sane default; typing another id is
              // still allowed, because a provider's usable id is not always catalogued.
              placeholder={model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              data-testid="assistant-model"
            />
          </label>
          <label className="library-field library-field-narrow">
            <span>Temp</span>
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={draft.temperature}
              onChange={(event) => setDraft({ ...draft, temperature: event.target.value })}
              data-testid="assistant-temperature"
            />
          </label>
        </div>

        <label className="library-field">
          <span>System prompt</span>
          <textarea
            rows={3}
            value={draft.systemPrompt}
            placeholder={"You are… Use {{date}}, {{thread_title}}, {{project_name}}."}
            onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
            data-testid="assistant-prompt"
          />
        </label>

        <div className="library-form-actions">
          <button
            type="submit"
            className="btn btn-small"
            disabled={busy || !canSave}
            data-testid="assistant-save"
          >
            {editingId === null ? "Create assistant" : "Save changes"}
          </button>
          {editingId !== null && (
            <button
              type="button"
              className="btn btn-small"
              onClick={reset}
              data-testid="assistant-cancel"
            >
              Cancel
            </button>
          )}
          {invalidTemperature(draft.temperature) && (
            <output className="composer-note bad">Temperature must be between 0 and 2.</output>
          )}
        </div>
      </form>

      {error !== null && (
        <p className="sidebar-error" role="alert" data-testid="assistant-error">
          <span className="banner-code">{error.code}</span> {error.message}
        </p>
      )}

      {catalog.state === "loading" && <p className="sidebar-note muted">Loading assistants…</p>}

      {catalog.state === "error" && (
        <p className="sidebar-error" role="alert" data-testid="assistant-list-error">
          <span className="banner-code">{catalog.error.code}</span> {catalog.error.message}
        </p>
      )}

      {catalog.state === "empty" && (
        <p className="sidebar-note muted" data-testid="assistant-list-empty">
          No assistants yet. Create one above, then pick it in the composer.
        </p>
      )}

      {catalog.state === "ready" && (
        <ul className="library-list" data-testid="assistant-list">
          {catalog.items.map((assistant) => (
            <li className="library-row" key={assistant.id}>
              <div className="library-row-main">
                <span className="library-row-title">{assistant.name}</span>
                <span className="library-row-meta">
                  {assistant.model} · temp {assistant.temperature}
                </span>
                {assistant.systemPrompt.trim() !== "" && (
                  <span className="library-row-body">{assistant.systemPrompt}</span>
                )}
              </div>
              <div className="library-row-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    setEditingId(assistant.id);
                    setDraft(draftOf(assistant));
                  }}
                  data-testid="assistant-edit"
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-stop"
                  disabled={busy}
                  onClick={() => void remove(assistant.id)}
                  data-testid="assistant-delete"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { Attachment } from "@shared/ipc-contract";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { AssistantSummary } from "../hooks/use-assistants";
import {
  ACCEPT_ATTRIBUTE,
  type AttachmentProblem,
  attachmentPathsFromFiles,
  describeAttachmentFailure,
  tooManyProblem,
  unresolvedPathsProblem,
} from "../lib/attachments";
import type { Catalog } from "../lib/catalogs";
import { describeCatalogState } from "../lib/catalogs";
import { addAttachments } from "../lib/ipc";
import { describeCatalog, type ModelCatalog } from "../lib/models";
import { AttachmentChip } from "./AttachmentChip";

/**
 * Enter sends, Shift+Enter is a newline, and the caret is in here on mount so the
 * app is usable from the keyboard without a click. The IME guard matters: pressing
 * Enter to accept a composition must not send a half-typed message.
 *
 * The model select is the provider's catalogue (P0), not a constant. When that
 * catalogue is loading, empty, or failed, the select says so and stays disabled while
 * still showing the id that would be sent — an empty select would be indistinguishable
 * from a working one with no models.
 *
 * D4 adds the three ways a file arrives — the attach button, a drop on the composer, and a
 * paste — and one refusal path for all three. The files are *copied* by main when they are
 * added, not when the turn is sent, so the chips on screen are already durable: navigating
 * away and back cannot lose them, and a send only has to pass their ids.
 *
 * D6 adds two things above the textarea: the assistant picker and the button that opens
 * the library. Picking an assistant takes the model and temperature out of the user's
 * hands, so the model select is replaced by a statement of what will actually be sent
 * rather than left showing a value that is no longer used.
 */

/** Mirrors `chat.send.attachmentIds.max(10)`: a turn cannot carry more than this. */
const MAX_ATTACHMENTS = 10;

/** The title attribute's short form. Long enough to be useful, short enough for a tooltip. */
const ACCEPTED_LABEL = "PNG, JPG, WebP, GIF, PDF, TXT, MD";

/** A prompt the library asked to put in the textarea; `nonce` makes a repeat insert fire. */
export interface PromptInsertion {
  text: string;
  nonce: number;
}

export function Composer({
  streaming,
  disabled,
  model,
  models,
  onModelChange,
  onSend,
  onStop,
  assistants,
  assistantId,
  onAssistantChange,
  promptToInsert,
  onOpenLibrary,
}: {
  streaming: boolean;
  disabled: boolean;
  model: string;
  models: ModelCatalog;
  onModelChange: (model: string) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  /** The assistant picker's list and the four states it can be in. */
  assistants: Catalog<AssistantSummary>;
  /** Null means "no assistant": the model select decides, as it did before D6. */
  assistantId: string | null;
  onAssistantChange: (assistantId: string | null) => void;
  /** Set by the library; appended to whatever is already typed. */
  promptToInsert: PromptInsertion | null;
  onOpenLibrary: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [problem, setProblem] = useState<AttachmentProblem | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  /**
   * An inserted prompt is appended, not substituted: the user may have typed an
   * instruction already, and replacing it would throw away work they can see.
   */
  useEffect(() => {
    if (promptToInsert === null) return;
    setValue((current) =>
      current.trim() === "" ? promptToInsert.text : `${current}\n\n${promptToInsert.text}`,
    );
    input.current?.focus();
  }, [promptToInsert]);

  const remove = (id: string): void => {
    setPending((current) => current.filter((attachment) => attachment.id !== id));
  };

  /**
   * Asks main to copy these files and adds the accepted ones to the composer.
   *
   * The batch is refused whole when it would exceed the cap rather than accepting the
   * first ten and dropping the rest: a drop of twelve files that quietly became ten would
   * look like it worked, and the two missing files are the ones the user would only notice
   * after sending.
   */
  const addPaths = async (paths: readonly string[]): Promise<void> => {
    if (paths.length === 0 || disabled) return;

    if (pending.length + paths.length > MAX_ATTACHMENTS) {
      setProblem(tooManyProblem(MAX_ATTACHMENTS));
      return;
    }

    setAttaching(true);
    setProblem(null);
    try {
      const result = await addAttachments(paths);
      if (!result.ok) {
        setProblem(describeAttachmentFailure(result.error));
        return;
      }
      setPending((current) => [...current, ...result.data.attachments]);
    } finally {
      setAttaching(false);
    }
  };

  /**
   * Paths for whichever files arrived, or a problem saying there are none to be had.
   *
   * A partial batch is refused rather than half-attached: the user dropped three files and
   * would see two chips, which reads as "it worked" until the message is sent.
   */
  const acceptFiles = (files: readonly File[]): void => {
    const { paths, unresolved } = attachmentPathsFromFiles(files);
    if (unresolved.length > 0) {
      setProblem(unresolvedPathsProblem(unresolved.length));
      return;
    }
    void addPaths(paths);
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    const files = Array.from(event.dataTransfer.files);
    setDragging(false);
    // A drag carrying text or a link is not an attachment; leave it to the browser.
    if (files.length === 0) return;
    event.preventDefault();
    acceptFiles(files);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files);
    // An ordinary text paste. Nothing to do, and nothing that should be swallowed.
    if (files.length === 0) return;
    event.preventDefault();
    acceptFiles(files);
  };

  const onPicked = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    // Clear the input so picking the same file twice still fires a change.
    event.target.value = "";
    acceptFiles(files);
  };

  const submit = (): void => {
    const text = value.trim();
    if (text === "" || streaming || disabled || attaching) return;
    // The metadata goes up with the ids it came from, so the turn's chips can render
    // before a reload would have to read them back out of the database.
    const attachments = pending;
    setValue("");
    setPending([]);
    setProblem(null);
    onSend(text, attachments);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const catalogue = describeCatalog(models);

  /**
   * Archived or otherwise unlisted assistants still work — main resolves them by id —
   * so a selected id that is not in the list is shown as "(not listed)" rather than
   * silently dropped to "None", which would change what the next turn sends.
   */
  const assistantOptions: readonly AssistantSummary[] =
    assistants.state === "ready" ? assistants.items : [];
  const activeAssistant = assistantOptions.find((option) => option.id === assistantId) ?? null;
  const assistantListed = assistantId === null || activeAssistant !== null;
  const assistantNote =
    assistants.state === "ready"
      ? null
      : describeCatalogState(assistants, {
          noun: "assistants",
          empty: "No assistants yet — create one in the Library.",
        });

  return (
    // A group of related controls that also accepts a file dropped anywhere on it. A
    // fieldset rather than a div because that is the element for "these controls belong
    // together", and it makes the drop target a labelled group instead of an anonymous box.
    <fieldset
      aria-label="Composer"
      className="composer"
      data-dragging={dragging}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {pending.length > 0 && (
        <ul className="attach-list attach-pending" data-testid="pending-attachments">
          {pending.map((attachment) => (
            <AttachmentChip key={attachment.id} attachment={attachment} onRemove={remove} />
          ))}
        </ul>
      )}

      {problem !== null && (
        <div className="attach-problem" role="alert" data-testid={problem.testId}>
          <strong className="attach-problem-title">{problem.title}</strong>
          <span className="attach-problem-detail">{problem.detail}</span>
          <button
            type="button"
            className="attach-problem-close"
            aria-label="Dismiss"
            onClick={() => setProblem(null)}
          >
            ×
          </button>
        </div>
      )}

      <textarea
        ref={input}
        className="composer-input"
        aria-label="Message"
        placeholder="Message Cleon..."
        rows={3}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="composer-actions">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={ACCEPT_ATTRIBUTE}
          data-testid="attachment-input"
          onChange={onPicked}
        />
        <button
          type="button"
          className="btn btn-small btn-attach"
          aria-label="Attach files"
          title={`Attach a file (${ACCEPTED_LABEL})`}
          data-testid="attach"
          disabled={disabled || attaching || streaming || pending.length >= MAX_ATTACHMENTS}
          onClick={() => picker.current?.click()}
        >
          {attaching ? "…" : "＋"}
        </button>
        <button
          type="button"
          className="btn btn-small btn-library"
          aria-label="Open prompt library"
          title="Prompts and assistants"
          data-testid="open-library"
          disabled={disabled}
          onClick={onOpenLibrary}
        >
          ⌘ Library
        </button>
        <label className="model-picker">
          <span>Assistant</span>
          <select
            aria-label="Assistant"
            data-testid="composer-assistant"
            value={assistantId ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onAssistantChange(event.target.value === "" ? null : event.target.value)
            }
          >
            <option value="">None</option>
            {!assistantListed && <option value={assistantId ?? ""}>(not listed)</option>}
            {assistantOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        {assistantNote !== null && (
          <output
            className={`composer-note ${assistantNote.tone}`}
            data-testid="composer-assistant-note"
          >
            {assistantNote.text}
          </output>
        )}
        {assistantId === null ? (
          <label className="model-picker">
            <span>Model</span>
            <select
              aria-label="Model"
              data-testid="composer-model"
              value={model}
              disabled={models.state !== "ready"}
              onChange={(event) => onModelChange(event.target.value)}
            >
              {models.state === "ready" ? (
                models.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.id}
                  </option>
                ))
              ) : (
                <option value={model}>{model}</option>
              )}
            </select>
          </label>
        ) : (
          // With an assistant picked there is nothing to select: the model and the
          // temperature come from it. Stating them is honest; showing a select that
          // does not decide what gets sent is not. While the assistant's own row is not
          // on screen yet, the statement says so rather than guessing a model id.
          <output className="composer-fixed" data-testid="composer-model-locked">
            {activeAssistant === null
              ? "Model and temperature come from the selected assistant."
              : `${activeAssistant.model} · temp ${activeAssistant.temperature}`}
          </output>
        )}
        {assistantId === null && models.state !== "ready" && (
          <output className={`composer-note ${catalogue.tone}`} data-testid="composer-model-note">
            {catalogue.text}
          </output>
        )}
        <div className="composer-buttons">
          <button
            type="button"
            className="btn"
            disabled={streaming || disabled || value.trim() === ""}
            onClick={submit}
          >
            Send
          </button>
          {streaming && (
            <button type="button" className="btn btn-stop" onClick={onStop}>
              Stop
            </button>
          )}
        </div>
      </div>
    </fieldset>
  );
}

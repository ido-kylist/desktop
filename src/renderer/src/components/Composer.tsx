import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { describeCatalog, type ModelCatalog } from "../lib/models";

/**
 * Enter sends, Shift+Enter is a newline, and the caret is in here on mount so the
 * app is usable from the keyboard without a click. The IME guard matters: pressing
 * Enter to accept a composition must not send a half-typed message.
 *
 * The model select is the provider's catalogue (P0), not a constant. When that
 * catalogue is loading, empty, or failed, the select says so and stays disabled while
 * still showing the id that would be sent — an empty select would be indistinguishable
 * from a working one with no models.
 */
export function Composer({
  streaming,
  disabled,
  model,
  models,
  onModelChange,
  onSend,
  onStop,
}: {
  streaming: boolean;
  disabled: boolean;
  model: string;
  models: ModelCatalog;
  onModelChange: (model: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const input = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = (): void => {
    const text = value.trim();
    if (text === "" || streaming || disabled) return;
    setValue("");
    onSend(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const catalogue = describeCatalog(models);

  return (
    <div className="composer">
      <textarea
        ref={input}
        className="composer-input"
        aria-label="Message"
        placeholder="Message Cleon..."
        rows={3}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-actions">
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
        {models.state !== "ready" && (
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
    </div>
  );
}

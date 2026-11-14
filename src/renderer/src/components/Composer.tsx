import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { SELECTABLE_MODELS } from "../lib/models";

/**
 * Enter sends, Shift+Enter is a newline, and the caret is in here on mount so the
 * app is usable from the keyboard without a click. The IME guard matters: pressing
 * Enter to accept a composition must not send a half-typed message.
 */
export function Composer({
  streaming,
  disabled,
  model,
  onModelChange,
  onSend,
  onStop,
}: {
  streaming: boolean;
  disabled: boolean;
  model: string;
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
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {SELECTABLE_MODELS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
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

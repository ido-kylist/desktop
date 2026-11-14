import type { ToolCallView } from "../store/chat-store";

const PREVIEW_LIMIT = 120;

/**
 * One line of evidence about what the model asked for. Arguments arrive as parsed
 * JSON (or as the raw fragment when they never parsed), so both are flattened to a
 * single truncated string — a tool row is a receipt, not a data browser.
 */
function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

export function ToolRows({ calls }: { calls: readonly ToolCallView[] }): React.JSX.Element {
  return (
    <div className="tools">
      {calls.map((call) => (
        <div className="tool" key={call.callId}>
          <div className="tool-row">
            <span className="tool-name">{call.name === "" ? "tool" : call.name}</span>
            <span className="tool-args">{preview(call.args)}</span>
          </div>
          {call.ok !== null && (
            <div className="tool-row tool-result">
              <span className={call.ok ? "ok" : "bad"}>{call.ok ? "result" : "failed"}</span>
              <span className="tool-args">{preview(call.result)}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

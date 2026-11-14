import type { ChatMessageView } from "../store/chat-store";
import { Markdown } from "./Markdown";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolRows } from "./ToolRows";

/**
 * One turn. Assistant text is Markdown; user text is literal (`white-space:
 * pre-wrap` in CSS), because echoing the user's own words back through a Markdown
 * parser would render their asterisks as formatting they did not write.
 */
export function MessageItem({ message }: { message: ChatMessageView }): React.JSX.Element {
  if (message.role === "user") {
    return (
      <article className="msg msg-user" data-role="user">
        <div className="bubble bubble-user">{message.text}</div>
      </article>
    );
  }

  if (message.role !== "assistant") {
    return (
      <article className="msg msg-other" data-role={message.role}>
        <div className="bubble">{message.text}</div>
      </article>
    );
  }

  return (
    <article className="msg msg-assistant" data-role="assistant">
      {message.reasoning !== "" && <ReasoningBlock text={message.reasoning} />}
      {message.toolCalls.length > 0 && <ToolRows calls={message.toolCalls} />}
      {message.text !== "" ? (
        <Markdown text={message.text} />
      ) : (
        message.errorCode === null && <span className="muted">…</span>
      )}
    </article>
  );
}

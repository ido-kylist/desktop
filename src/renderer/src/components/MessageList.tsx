import type { ChatMessageView } from "../store/chat-store";
import { MessageItem } from "./MessageItem";

export function MessageList({
  messages,
}: {
  messages: readonly ChatMessageView[];
}): React.JSX.Element {
  if (messages.length === 0) {
    return (
      <div className="empty">
        <h2>New thread</h2>
        <p className="muted">
          The conversation is stored locally. Only the inference request leaves this machine.
        </p>
      </div>
    );
  }

  return (
    <div className="messages">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
    </div>
  );
}

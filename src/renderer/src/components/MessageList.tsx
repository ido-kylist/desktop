import type { VariantGroup } from "../lib/variants";
import type { ChatMessageView } from "../store/chat-store";
import { MessageItem } from "./MessageItem";

/**
 * The transcript. Regenerate belongs to the newest answer only: regenerating an
 * older turn would fork a branch that the rest of the thread does not continue from.
 *
 * `streamingMessageId` names the answer a generation is writing into. It exists so the
 * live region can be on that message's body and on nothing else — see `Markdown`.
 */
export function MessageList({
  messages,
  groups,
  busy,
  streamingMessageId,
  onSwitchVariant,
  onRegenerate,
}: {
  messages: readonly ChatMessageView[];
  groups: Record<string, VariantGroup>;
  busy: boolean;
  streamingMessageId: string | null;
  onSwitchVariant: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
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

  let lastAssistantId: string | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "assistant") {
      lastAssistantId = message.id;
      break;
    }
  }

  return (
    <div className="messages">
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          variant={groups[message.id]}
          canRegenerate={message.id === lastAssistantId}
          busy={busy}
          streaming={message.id === streamingMessageId}
          onSwitchVariant={onSwitchVariant}
          onRegenerate={() => onRegenerate(message.id)}
        />
      ))}
    </div>
  );
}

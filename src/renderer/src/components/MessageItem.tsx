import type { VariantGroup } from "../lib/variants";
import type { ChatMessageView } from "../store/chat-store";
import { Markdown } from "./Markdown";
import { MessageAttachments } from "./MessageAttachments";
import { MessageCitations } from "./MessageCitations";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolRows } from "./ToolRows";
import { UsageMeter } from "./UsageMeter";
import { VariantSwitcher } from "./VariantSwitcher";

/**
 * One turn. Assistant text is Markdown; user text is literal (`white-space:
 * pre-wrap` in CSS), because echoing the user's own words back through a Markdown
 * parser would render their asterisks as formatting they did not write.
 *
 * D3 adds the footer: the sibling count when this answer is one of several, the
 * regenerate affordance on the newest answer, and the meters when one exists.
 *
 * D4 adds the attachments above the user's text. They are metadata only — the chip asks
 * for its own thumbnail when it has one — so a message with three photographs still costs
 * the transcript three rows and no bytes.
 *
 * D8 adds the sources under an assistant answer: one chip per retrieved chunk, expanding to
 * the text it points at. They sit above the footer so the meter row stays the last thing in
 * the turn, and they render nothing at all for a turn that used no knowledge.
 *
 * `streaming` is true for exactly one turn at a time — the answer whose generation is live —
 * and it is what makes the body a polite live region while tokens land. A restored answer
 * has it false, so opening a thread announces nothing.
 */
export function MessageItem({
  message,
  variant,
  canRegenerate,
  busy,
  streaming,
  onSwitchVariant,
  onRegenerate,
}: {
  message: ChatMessageView;
  variant: VariantGroup | undefined;
  canRegenerate: boolean;
  busy: boolean;
  streaming: boolean;
  onSwitchVariant: (messageId: string) => void;
  onRegenerate: () => void;
}): React.JSX.Element {
  if (message.role === "user") {
    return (
      <article className="msg msg-user" data-role="user">
        <div className="bubble bubble-user">
          <MessageAttachments attachments={message.attachments ?? []} />
          {message.text}
        </div>
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

  const usage = message.usage ?? null;

  return (
    <article
      className="msg msg-assistant"
      data-role="assistant"
      {...(streaming ? { "data-streaming": "true" } : {})}
    >
      {message.reasoning !== "" && <ReasoningBlock text={message.reasoning} />}
      {message.toolCalls.length > 0 && <ToolRows calls={message.toolCalls} />}
      {message.text !== "" ? (
        <Markdown text={message.text} live={streaming} />
      ) : (
        message.errorCode === null && <span className="muted">…</span>
      )}

      <MessageCitations citations={message.citations ?? []} />

      {(variant !== undefined || canRegenerate || usage !== null) && (
        <div className="msg-footer">
          {variant !== undefined && (
            <VariantSwitcher group={variant} busy={busy} onPick={onSwitchVariant} />
          )}
          {canRegenerate && (
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={onRegenerate}
              data-testid="regenerate"
            >
              Regenerate
            </button>
          )}
          {usage !== null && <UsageMeter usage={usage} />}
        </div>
      )}
    </article>
  );
}

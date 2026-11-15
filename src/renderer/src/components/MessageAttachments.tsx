import type { Attachment } from "@shared/ipc-contract";
import { AttachmentChip } from "./AttachmentChip";

/**
 * The attachments on one message.
 *
 * Rendered only when there are any: an empty list would leave a gap under every turn in a
 * thread that never had a file.
 */
export function MessageAttachments({
  attachments,
}: {
  attachments: readonly Attachment[];
}): React.JSX.Element | null {
  if (attachments.length === 0) return null;

  return (
    <ul className="attach-list" data-testid="message-attachments">
      {attachments.map((attachment) => (
        <AttachmentChip key={attachment.id} attachment={attachment} />
      ))}
    </ul>
  );
}

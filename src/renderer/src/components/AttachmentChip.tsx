import type { Attachment } from "@shared/ipc-contract";
import { useEffect, useState } from "react";
import { formatBytes } from "../lib/attachments";
import { previewAttachment } from "../lib/ipc";

/**
 * One attached file, as a chip.
 *
 * The thumbnail is fetched rather than carried: the contract keeps bytes out of every
 * message shape, and a list of images inlined per message would put megabytes in the
 * thread read. `previewAttachment` answers `dataUrl: null` for anything large or
 * non-image, and the chip falls back to a kind mark — never to an empty box.
 *
 * `onRemove` is what tells the two uses apart. A pending attachment is the user's to take
 * back; one on a sent message is history.
 */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove?: (id: string) => void;
}): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (attachment.kind !== "image") return;
    // The chip can unmount while the preview is in flight (the user removes it, the thread
    // is re-read); a late answer must not write state onto a component that is gone.
    let live = true;

    void previewAttachment(attachment.id).then((result) => {
      if (live && result.ok) setDataUrl(result.data.dataUrl);
    });

    return () => {
      live = false;
    };
  }, [attachment.id, attachment.kind]);

  return (
    <li className="attach-chip" data-testid="attachment-chip" data-kind={attachment.kind}>
      {dataUrl === null ? (
        <span className="attach-mark" aria-hidden="true">
          {attachment.kind === "image" ? "▣" : "▤"}
        </span>
      ) : (
        <img className="attach-thumb" src={dataUrl} alt="" />
      )}
      <span className="attach-body">
        <span className="attach-name" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="attach-size">{formatBytes(attachment.sizeBytes)}</span>
      </span>
      {onRemove !== undefined && (
        <button
          type="button"
          className="attach-remove"
          aria-label={`Remove ${attachment.filename}`}
          data-testid="attachment-remove"
          onClick={() => onRemove(attachment.id)}
        >
          ×
        </button>
      )}
    </li>
  );
}

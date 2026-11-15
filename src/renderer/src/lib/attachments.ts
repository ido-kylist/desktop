import type { IpcError } from "@shared/ipc-contract";

/**
 * The composer's attachment decisions, without the composer.
 *
 * Two things are decided here and nowhere else: how a refusal from main becomes
 * something a user can act on, and how a dropped or pasted `File` becomes a path main can
 * read. Both are pure, so every branch is asserted without a DOM — a `too_large` file and a
 * `too_many` batch have to look *different* on screen, and "different" is a property of
 * this module rather than of the JSX around it.
 *
 * One thing this file cannot decide: the renderer never learns a path from a browser
 * `File`. `File.path` was an Electron extension and is gone from the current runtime, so
 * the paths have to be supplied by a preload helper that this frozen slice does not have.
 * `attachmentPathsFromFiles` reads what is there; when nothing is, the composer says so
 * instead of silently attaching nothing.
 */

/**
 * The reason codes main puts in `details.reason`.
 *
 * `details` is an open record on the wire, so this is the renderer's decode of it rather
 * than a shared schema. It mirrors `src/main/attachments/store.ts` plus the two send-time
 * codes from `repo-attachments.ts`.
 */
export type AttachmentRejectReason =
  | "too_many"
  | "too_large"
  | "unsupported_type"
  | "unknown_attachment"
  | "attachment_taken";

/** The reason codes this renderer can render a specific state for. */
const REJECT_REASONS: readonly AttachmentRejectReason[] = [
  "too_many",
  "too_large",
  "unsupported_type",
  "unknown_attachment",
  "attachment_taken",
];

/**
 * The reason main put in `details`, or null when it is not one this build knows.
 *
 * Null rather than the raw string: a build that meets a reason from a newer main has to fall
 * back to the generic state rather than render a code as if it were a sentence.
 */
export function rejectReasonOf(
  details: Record<string, unknown> | undefined,
): AttachmentRejectReason | null {
  const value = stringDetail(details, "reason");
  return REJECT_REASONS.find((reason) => reason === value) ?? null;
}

/** One refusal, ready to render. `testId` is per-reason so a test can tell them apart. */
export interface AttachmentProblem {
  reason: string;
  title: string;
  detail: string;
  testId: string;
}

/** The extensions the picker offers. A hint only: main decides what it accepts. */
export const ACCEPTED_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
  ".txt",
  ".md",
];

/** What the file input's `accept` attribute gets. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(",");

/**
 * A byte count as a chip label. Binary units, because the cap main enforces (25 MiB) is
 * binary and a file that is refused at "26 MB" while reading "25 MB" here would be a lie.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;

  const kib = bytes / 1024;
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`;

  const mib = kib / 1024;
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`;
}

/**
 * One refusal, one distinct state.
 *
 * The reasons are kept apart rather than folded into "attachment failed" because the user's
 * next action is different in each case: shrink the file, send fewer, pick another format,
 * or re-attach. A single generic message would tell them their file was rejected and leave
 * them to guess which rule they broke.
 */
export function describeAttachmentFailure(error: IpcError): AttachmentProblem {
  const reason = rejectReasonOf(error.details);

  if (reason === "too_large") {
    const filename = stringDetail(error.details, "filename") ?? "That file";
    const limitBytes = numberDetail(error.details, "limitBytes");
    return {
      reason,
      title: "File too large",
      detail:
        limitBytes === null
          ? `${filename} is larger than the attachment limit.`
          : `${filename} is over the limit. Attach files up to ${formatBytes(limitBytes)} each.`,
      testId: "attachment-error-too_large",
    };
  }

  if (reason === "too_many") {
    return tooManyProblem(numberDetail(error.details, "limit") ?? 0);
  }

  if (reason === "unsupported_type") {
    const filename = stringDetail(error.details, "filename") ?? "That file";
    return {
      reason,
      title: "Unsupported file type",
      detail: `${filename} is not a type Cleon can read. Attach an image (PNG, JPG, WebP, GIF) or a document (PDF, TXT, MD).`,
      testId: "attachment-error-unsupported_type",
    };
  }

  if (reason === "unknown_attachment") {
    return {
      reason,
      title: "Attachment unavailable",
      detail: "One of these files is no longer stored. Remove it and attach it again.",
      testId: "attachment-error-unknown_attachment",
    };
  }

  if (reason === "attachment_taken") {
    return {
      reason,
      title: "Attachment already sent",
      detail:
        "One of these files already belongs to another message. Attach it again to send it here.",
      testId: "attachment-error-attachment_taken",
    };
  }

  return {
    reason: reason ?? "unknown",
    title: "Could not attach",
    detail: error.message,
    testId: "attachment-error",
  };
}

/**
 * The state for a drop the renderer cannot turn into paths.
 *
 * This is not main refusing anything — it is the renderer admitting it cannot say which
 * file was meant. Distinct on purpose: the fix is a platform one, not a file the user can
 * change.
 */
export function unresolvedPathsProblem(count: number): AttachmentProblem {
  const files = count === 1 ? "that file" : `${count} of those files`;
  const pronoun = count === 1 ? "it" : "them";
  return {
    reason: "unresolved_paths",
    title: "Cannot read file location",
    detail: `This build cannot read the location of ${files}, so it cannot attach ${pronoun}. Dropping, pasting, and picking all need a file-path helper on the preload bridge, which this build does not expose yet.`,
    testId: "attachment-error-unresolved_paths",
  };
}

/**
 * The cap state, for both the refusal main sends and the one the composer reaches on its
 * own: two more files on top of nine already pending never leave the renderer, but it is
 * the same rule, so it is the same message.
 */
export function tooManyProblem(limit: number): AttachmentProblem {
  return {
    reason: "too_many",
    title: "Too many files",
    detail:
      limit > 0
        ? `A message can carry ${limit} files. Remove one before adding another.`
        : "That is more files than one message can carry.",
    testId: "attachment-error-too_many",
  };
}

/**
 * Absolute paths for the files a drop, a paste, or the picker handed over.
 *
 * A browser `File` carries bytes and a name, never a location. `path` is read because older
 * Electron builds put it there; when it is absent the file is reported as unresolved rather
 * than dropped, so a partial batch cannot look like a complete one.
 */
export function attachmentPathsFromFiles(files: readonly unknown[]): {
  paths: string[];
  unresolved: string[];
} {
  const paths: string[] = [];
  const unresolved: string[] = [];

  for (const entry of files) {
    const file = entry as { path?: unknown; name?: unknown } | null;
    const path = typeof file?.path === "string" ? file.path.trim() : "";
    if (path !== "") {
      paths.push(path);
      continue;
    }
    unresolved.push(
      typeof file?.name === "string" && file.name !== "" ? file.name : "an unnamed file",
    );
  }

  return { paths, unresolved };
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | null {
  if (details === undefined) return null;
  const value = details[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function numberDetail(details: Record<string, unknown> | undefined, key: string): number | null {
  if (details === undefined) return null;
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

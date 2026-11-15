import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ChannelName,
  contracts,
  type IpcResult,
  type RequestOf,
  type ResponseOf,
} from "@shared/ipc-contract";
import { ipcMain } from "electron";
import type { DrizzleDb } from "../db/client.js";
import { getAttachmentById, insertAttachment } from "../db/repo-attachments.js";
import { AppError, toIpcError } from "../errors.js";
import { addAttachments, previewAttachment, toAttachmentMeta } from "./store.js";

/**
 * The two attachment channels.
 *
 * They are registered here rather than in the dispatcher because they need a directory
 * the dispatcher does not have: `<userData>/attachments` comes from `app.getPath`, and
 * passing it in keeps this module free of Electron's lifecycle — everything below
 * `createAttachmentHandlers` is a plain function over a connection and a directory, which
 * is what the integration test drives.
 *
 * Nothing here reads a file into a response except `preview`, and that only for a small
 * image. The bytes of an attached document never cross the boundary: main owns the file
 * system for the same reason it owns the SQL.
 */

/** The prefix the dispatcher registers under, and the preload invokes. */
const CHANNEL_PREFIX = "cleon:";

export interface AttachmentHandlerDeps {
  db: DrizzleDb;
  /** `<userData>/attachments`. Created on first use; never written outside. */
  rootDir: string;
}

/** The attachments directory for a user-data directory. */
export function attachmentsRoot(userDataDir: string): string {
  return join(userDataDir, "attachments");
}

export type AttachmentHandlers = {
  "attachments.add": (
    payload: RequestOf<"attachments.add">,
  ) => Promise<ResponseOf<"attachments.add">>;
  "attachments.preview": (
    payload: RequestOf<"attachments.preview">,
  ) => Promise<ResponseOf<"attachments.preview">>;
};

/**
 * The channel bodies, keyed the way the dispatcher's handler map is keyed, so a
 * composition root can either spread this into its own map or call
 * `registerAttachmentHandlers` and let this module own the registration.
 */
export function createAttachmentHandlers(deps: AttachmentHandlerDeps): AttachmentHandlers {
  const { db, rootDir } = deps;

  return {
    /**
     * Copy, then record. The copies come first because a row for a file that is not on
     * disk is a broken attachment the UI would show forever, whereas a file with no row is
     * only wasted bytes — and those are removed if the write fails.
     *
     * The rows go in one transaction. A batch that inserted eight of ten would leave the
     * composer showing two files that `chat.send` then cannot link.
     */
    "attachments.add": async ({ paths }) => {
      const stored = await addAttachments(paths, { rootDir });

      try {
        db.transaction((tx) => {
          for (const record of stored) insertAttachment(tx, record);
        });
      } catch (error) {
        // The metadata write failed, so the copies belong to nothing. Removing them keeps
        // a rejected call from accumulating bytes no row will ever point at again.
        await Promise.all(stored.map((record) => rm(record.storedPath, { force: true })));
        throw error;
      }

      return { attachments: stored.map(toAttachmentMeta) };
    },

    /**
     * A thumbnail, when there is one cheap enough to inline.
     *
     * An id that no longer exists is NOT_FOUND rather than an empty answer: the chip is
     * asking about a row the database says is gone, and the chip should disappear rather
     * than pretend the file has no picture.
     */
    "attachments.preview": async ({ id }) => {
      const row = getAttachmentById(db, id);
      if (row === null) {
        throw new AppError("NOT_FOUND", "attachment not found", { details: { id } });
      }
      return previewAttachment(row, { rootDir });
    },
  };
}

/**
 * Registers both channels with the dispatcher's envelope discipline: the request is parsed
 * against the frozen contract, and a handler never throws across the boundary — it returns
 * `{ ok: false, error }` with a code from the closed set.
 */
export function registerAttachmentHandlers(deps: AttachmentHandlerDeps): void {
  const handlers = createAttachmentHandlers(deps);
  registerChannel("attachments.add", handlers["attachments.add"]);
  registerChannel("attachments.preview", handlers["attachments.preview"]);
}

function registerChannel<C extends ChannelName>(
  channel: C,
  handler: (payload: RequestOf<C>) => Promise<ResponseOf<C>>,
): void {
  ipcMain.handle(
    `${CHANNEL_PREFIX}${channel}`,
    async (_event, payload: unknown): Promise<IpcResult<unknown>> => {
      try {
        const request = contracts[channel].request.safeParse(payload);
        if (!request.success) {
          throw new AppError("BAD_REQUEST", `Invalid payload for ${channel}`, {
            details: { issues: request.error.issues },
          });
        }
        return { ok: true, data: await handler(request.data as RequestOf<C>) };
      } catch (error) {
        return { ok: false, error: toIpcError(error) };
      }
    },
  );
}

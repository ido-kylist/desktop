import type { IpcError } from "@shared/ipc-contract";

/**
 * "The provider cannot be reached" as a state, derived from the error rather than
 * invented as a new error code.
 *
 * The contract's closed set has `UPSTREAM_ERROR` for everything the provider did wrong,
 * and it covers two situations a user has to tell apart:
 *
 *  - **the provider answered and refused.** `httpError()` always attaches
 *    `details.status`, so a 400, a 402 and a 500 are all "we talked to it".
 *  - **the provider could not be talked to.** A refused connection, a DNS failure, a TLS
 *    failure and a timeout all arrive through the transport's catch, which attaches
 *    `details.reason` and *no* status. This is the offline case: the machine may have no
 *    network at all, or the endpoint is down.
 *
 * The distinction is structural, not a string match on the message: adding a code would
 * mean a protocol bump for a fact the existing payload already carries, and matching on
 * words like "fetch failed" would break the first time a message is reworded.
 *
 * `null` and every code other than `UPSTREAM_ERROR` are not this state — a `NOT_FOUND`
 * from the local database has nothing to do with the network, and calling it offline
 * would send a user to check a connection that is fine.
 */
export function isProviderUnreachable(error: IpcError | null): boolean {
  if (error === null || error.code !== "UPSTREAM_ERROR") return false;
  return error.details?.status === undefined;
}

/**
 * What the offline state says, in the one place it is written.
 *
 * It states three facts and promises nothing: the request did not leave (or did not come
 * back), the conversation is already on disk, and Retry is the action that changes once
 * the connection does. It never says "check your internet" as though that were the only
 * cause — a provider that is down looks exactly like this from here.
 */
export const OFFLINE_TITLE = "Provider unreachable";
export const OFFLINE_DETAIL =
  "The request could not reach the provider. Nothing was lost: the turn is stored locally.";

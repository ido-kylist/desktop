/**
 * The zod-free half of the contract.
 *
 * The sandboxed preload may only `require` electron and a few builtins, so it
 * cannot import the schema module — zod would be an unresolvable external at
 * runtime. Everything the preload actually needs lives here, with no imports at
 * all: the protocol version, the channel names, and the guard over them.
 *
 * `ipc-contract.ts` imports this file and proves with a `satisfies` clause that
 * every channel listed here has a schema. Adding a name without a schema is a
 * compile error, so the two halves cannot drift.
 */
export const PROTOCOL_VERSION = 2 as const;

export const CHANNEL_NAMES = ["app.info", "app.ping", "db.health", "scratch.wordCount"] as const;

export type ChannelName = (typeof CHANNEL_NAMES)[number];

export function isChannelName(value: unknown): value is ChannelName {
  return typeof value === "string" && (CHANNEL_NAMES as readonly string[]).includes(value);
}

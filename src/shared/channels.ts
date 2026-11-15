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
export const PROTOCOL_VERSION = 6 as const;

export const CHANNEL_NAMES = [
  "app.info",
  "app.ping",
  "db.health",
  "secrets.status",
  "secrets.setKey",
  "secrets.clearKey",
  "chat.send",
  "chat.stop",
  "chat.thread",
  "chat.regenerate",
  "chat.setActiveVariant",
  "threads.list",
  "threads.update",
  "threads.delete",
  "settings.get",
  "settings.set",
  "models.list",
  "attachments.add",
  "attachments.preview",
  "native.showLauncher",
] as const;

export type ChannelName = (typeof CHANNEL_NAMES)[number];

/**
 * The one main -> renderer push channel.
 *
 * It is deliberately not an entry in `CHANNEL_NAMES`: that tuple is the request/
 * response surface, and every member needs both halves of a schema. Generation
 * events are unsolicited and already fully described by `GenerationEventSchema`
 * in the contract module, so the name lives here — where the preload can read it
 * without pulling zod into the sandbox bridge.
 */
export const GENERATION_EVENT_CHANNEL = "generation:event" as const;

/**
 * Main -> renderer push for `cleon://` deep links. Carries an already-parsed target,
 * so the renderer never sees a raw URL and never has to trust one.
 */
export const DEEP_LINK_CHANNEL = "native:deep-link" as const;

export function isChannelName(value: unknown): value is ChannelName {
  return typeof value === "string" && (CHANNEL_NAMES as readonly string[]).includes(value);
}

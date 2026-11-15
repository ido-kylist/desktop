import type { ResponseOf } from "@shared/ipc-contract";

/**
 * The provider settings screen's logic, without the screen.
 *
 * Three questions are decided here and nowhere else: what a saved value looks like
 * on the wire, whether the draft differs from it, and how the key's state is worded.
 * The component keeps the pixels and the async calls; this module stays pure so every
 * branch — an empty URL, a trailing slash, a key that exists, one that does not — can
 * be asserted without a DOM.
 */

export type SettingsView = ResponseOf<"settings.get">;

/** What the base-URL field starts as, once `settings.get` has answered. */
export interface ProviderForm {
  baseUrl: string;
  hasKey: boolean;
  masked: string | null;
}

export function providerForm(settings: SettingsView): ProviderForm {
  return { baseUrl: settings.baseUrl ?? "", hasKey: settings.hasKey, masked: settings.masked };
}

/**
 * The value sent to main: trimmed, with the trailing slashes the transport would
 * otherwise see doubled (`baseUrl` is joined with `/v1/...`). Empty means "not
 * configured", which is `null` on the wire rather than an empty string.
 */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * Whether the draft differs from what is saved. Both sides are normalised first, so
 * adding and removing a trailing slash does not read as a pending change and the Save
 * button is not lit up for a difference main would discard anyway.
 */
export function isDirty(draft: string, saved: string | null): boolean {
  return normalizeBaseUrl(draft) !== normalizeBaseUrl(saved ?? "");
}

/**
 * The key's state, in words. `masked` is rendered exactly as main sent it — it is
 * already `••••` plus the tail (`SecretsService.masked()`), and re-masking it here
 * would either double the bullets or invent a tail the platform withheld. A key too
 * short to have a tail arrives as the bullets alone, which is the honest answer.
 */
export function keyStatus(hasKey: boolean, masked: string | null): string {
  if (!hasKey) return "No key stored.";
  if (masked === null || masked === "") return "A key is stored.";
  return masked;
}

/**
 * The note under the key field when nothing is stored. Null when a key exists, so the
 * caller renders nothing rather than an empty paragraph.
 */
export function missingKeyNote(hasKey: boolean): string | null {
  if (hasKey) return null;
  return "No key is stored. Cleon will not send one, and a provider will likely reject the request.";
}

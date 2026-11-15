/**
 * Display formatting for the meters and the sidebar rows.
 *
 * `costMicrocents` is integer millionths of a cent (schema comment), so a dollar is
 * 1e8 of them. Four decimals is the finest granularity that still reads as money at
 * the per-message scale: $0.0001 is one tenth of a cent.
 */

export const MICROCENTS_PER_DOLLAR = 100_000_000;

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costMicrocents: number;
}

export function formatCost(costMicrocents: number): string {
  return `$${(costMicrocents / MICROCENTS_PER_DOLLAR).toFixed(4)}`;
}

export function formatTokens(count: number): string {
  return count.toLocaleString("en-US");
}

/**
 * The sum over the messages that report usage. Null when no message does, so the
 * header shows nothing rather than a confident `$0.0000` for a thread that never
 * metered anything.
 */
export function sumUsage(messages: readonly { usage?: Usage | null }[]): Usage | null {
  const total: Usage = { promptTokens: 0, completionTokens: 0, costMicrocents: 0 };
  let seen = false;

  for (const message of messages) {
    const usage = message.usage;
    if (usage === null || usage === undefined) continue;
    seen = true;
    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.costMicrocents += usage.costMicrocents;
  }

  return seen ? total : null;
}

/** Coarse and dependency-free: the row needs a hint, not a formatted timestamp. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";

  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

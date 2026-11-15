import { formatCost, formatTokens, type Usage } from "../lib/format";

/**
 * The meters for one turn. Only rendered when a generation reported usage: a turn
 * nobody metered has no numbers, and `$0.0000` would be a made-up one.
 */
export function UsageMeter({ usage }: { usage: Usage }): React.JSX.Element {
  return (
    <span className="usage" data-testid="usage-meter">
      <span>{formatTokens(usage.promptTokens)} in</span>
      <span className="usage-sep">·</span>
      <span>{formatTokens(usage.completionTokens)} out</span>
      <span className="usage-sep">·</span>
      <span className="usage-cost">{formatCost(usage.costMicrocents)}</span>
    </span>
  );
}

/**
 * The thread's total, summed over the messages currently on screen — the active path,
 * not the branches it hides. Shown in the header so the number is visible without
 * scrolling to the last turn.
 */
export function UsageTotal({ usage }: { usage: Usage }): React.JSX.Element {
  const tokens = usage.promptTokens + usage.completionTokens;
  return (
    <span className="bar-total" data-testid="thread-total">
      {formatTokens(tokens)} tokens · {formatCost(usage.costMicrocents)}
    </span>
  );
}

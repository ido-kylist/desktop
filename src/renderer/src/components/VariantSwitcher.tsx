import type { VariantGroup } from "../lib/variants";

/**
 * "2 / 3" with an arrow either side.
 *
 * The arrows name the message to make active, not a direction: main decides what
 * "the previous variant" means in its own ordering, and the id is the only thing the
 * contract takes. The ends are disabled rather than wrapping, so the count on screen
 * never contradicts where the arrows can go.
 */
export function VariantSwitcher({
  group,
  busy,
  onPick,
}: {
  group: VariantGroup;
  busy: boolean;
  onPick: (messageId: string) => void;
}): React.JSX.Element {
  const previous = group.ids[group.index - 1];
  const next = group.ids[group.index + 1];

  return (
    <fieldset className="variants" aria-label="Answer variants">
      <button
        type="button"
        className="link-btn variant-arrow"
        aria-label="Previous variant"
        data-testid="variant-prev"
        disabled={busy || previous === undefined}
        onClick={() => {
          if (previous !== undefined) onPick(previous);
        }}
      >
        ‹
      </button>
      <span className="variant-count" data-testid="variant-count">
        {group.index + 1} / {group.ids.length}
      </span>
      <button
        type="button"
        className="link-btn variant-arrow"
        aria-label="Next variant"
        data-testid="variant-next"
        disabled={busy || next === undefined}
        onClick={() => {
          if (next !== undefined) onPick(next);
        }}
      >
        ›
      </button>
    </fieldset>
  );
}

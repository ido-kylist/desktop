import type { IpcError } from "@shared/ipc-contract";
import { useEffect, useMemo, useState } from "react";
import { isProviderUnreachable, OFFLINE_DETAIL, OFFLINE_TITLE } from "../lib/connectivity";

function remainingMs(deadline: number | null): number {
  if (deadline === null) return 0;
  return Math.max(0, deadline - Date.now());
}

/**
 * A failed turn, stated in the contract's own terms.
 *
 * The code is shown, not a generic string: `RATE_LIMITED` and `BUDGET_EXCEEDED` are
 * different problems with different answers, and the closed error set exists so the
 * UI can say which one happened.
 *
 * Retry re-sends the same user text as a new generation. It is withheld for
 * `BUDGET_EXCEEDED` — the request will fail identically until the budget changes, so
 * offering a button would be a lie. For `RATE_LIMITED` the button stays visible but
 * disabled until `retryAfterMs` has elapsed, with the wait on screen.
 *
 * `UPSTREAM_ERROR` with no HTTP status is the provider being unreachable — a refused
 * connection or a timeout rather than a refusal — and it is drawn as its own state
 * (`data-state="offline"`). Retry stays: unlike a budget, a dropped connection is
 * exactly the thing that comes back.
 */
export function ErrorBanner({
  error,
  retryText,
  onRetry,
}: {
  error: IpcError;
  retryText: string | null;
  onRetry: (text: string) => void;
}): React.JSX.Element {
  // Memoised on the error object: `Date.now()` on every render would rearm the timer
  // below on every render.
  const deadline = useMemo(
    () => (error.retryAfterMs === undefined ? null : Date.now() + error.retryAfterMs),
    [error],
  );

  const [remaining, setRemaining] = useState(() => remainingMs(deadline));

  useEffect(() => {
    if (deadline === null) {
      setRemaining(0);
      return;
    }
    setRemaining(remainingMs(deadline));
    const timer = window.setInterval(() => setRemaining(remainingMs(deadline)), 250);
    return () => window.clearInterval(timer);
  }, [deadline]);

  const retryable = error.code !== "BUDGET_EXCEEDED" && retryText !== null;
  const offline = isProviderUnreachable(error);

  return (
    <div
      className="banner"
      role="alert"
      data-testid="error-banner"
      data-state={offline ? "offline" : "failed"}
    >
      <div className="banner-main">
        <span className="banner-code">{error.code}</span>
        <span className="banner-message">{error.message}</span>
      </div>
      {offline && (
        <span className="banner-note" data-testid="error-banner-offline">
          {OFFLINE_TITLE} — {OFFLINE_DETAIL}
        </span>
      )}
      {remaining > 0 && (
        <span className="banner-countdown">Retry in {Math.ceil(remaining / 1000)}s</span>
      )}
      {error.code === "BUDGET_EXCEEDED" && (
        <span className="banner-note">Retrying will not change the answer.</span>
      )}
      {retryable && (
        <button
          type="button"
          className="btn"
          disabled={remaining > 0}
          onClick={() => {
            if (retryText !== null) onRetry(retryText);
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

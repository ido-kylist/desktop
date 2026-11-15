import { useEffect, useState } from "react";

/**
 * A value that only settles after the input has been quiet for `delayMs`.
 *
 * Used for the thread search: every keystroke would otherwise be its own FTS query,
 * and the intermediate terms are never what the user meant.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

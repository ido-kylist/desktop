import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";

/** Close enough to the bottom that the next token should keep following it. */
const STICK_THRESHOLD_PX = 24;

export interface AutoScroll {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}

/**
 * Follows the bottom while the answer streams, and stops the moment the user scrolls
 * away — nothing is worse than a transcript that yanks itself down while you are
 * reading further up. Scrolling back to the bottom resumes following.
 *
 * The effect has no dependency list on purpose: it runs after every render, which is
 * exactly when the transcript may have grown by a token. Reading and writing
 * `scrollTop` is cheap, and the stick check makes it a no-op whenever the user has
 * taken over.
 */
export function useAutoScroll(): AutoScroll {
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const onScroll = useCallback(() => {
    const node = ref.current;
    if (node === null) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    stick.current = distanceFromBottom <= STICK_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (node === null || !stick.current) return;
    node.scrollTop = node.scrollHeight;
  });

  return { ref, onScroll };
}

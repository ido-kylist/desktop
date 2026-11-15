import { type RefObject, useEffect, useRef } from "react";

/**
 * Keyboard entry and exit for a modal panel.
 *
 * Every panel in this app is a `role="dialog" aria-modal="true"` overlay drawn on top of
 * the window, and until this hook existed opening one with the keyboard left focus on the
 * button behind it: the overlay was announced by nothing and `Tab` walked the page
 * underneath it. Two rules are what make a modal usable without a pointer, and neither is
 * something `axe` can assert — they are behaviour, not markup:
 *
 *  1. **Focus moves into the panel on open.** The panel itself takes focus (it is
 *     `tabIndex={-1}`), so the next `Tab` is the panel's first control and a screen reader
 *     reads the dialog's label and its contents rather than the sidebar.
 *  2. **Focus returns to where it came from on close.** A user who opened MCP with the
 *     keyboard and closed it has to land back on the MCP button, not at the top of the
 *     document.
 *
 * Escape closes, because a modal that can only be dismissed by clicking a ✕ is a modal a
 * keyboard user has to tab through to escape.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onDismiss: () => void): void {
  // A ref, so a new inline callback on every render does not tear the effect down and take
  // focus with it.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss.current();
    };
    node.addEventListener("keydown", onKeyDown);

    return () => {
      node.removeEventListener("keydown", onKeyDown);
      // The opener can be gone (a thread deleted while the panel was open); focusing a
      // detached node is a no-op that React dev builds warn about.
      if (previous?.isConnected === true) previous.focus();
    };
  }, [ref]);
}

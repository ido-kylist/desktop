/**
 * Desktop notifications, with the one rule that matters: unsupported is silent.
 *
 * `Notification.isSupported()` is false in a Linux session with no notification
 * daemon and in headless environments, and `show()` there does nothing useful. The
 * caller gets a boolean, so "could not tell the user" is a value it can ignore
 * rather than an exception it has to catch for a turn that already succeeded.
 *
 * Nothing in the D5 shell calls this yet: it is the seam the next slice's background
 * work needs (a long generation finishing while the window is behind another app).
 */
import { Notification } from "electron";

export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
}

/** False when this platform cannot show a notification at all. */
export function canNotify(): boolean {
  try {
    return Notification.isSupported();
  } catch (error) {
    console.warn("[native] notification support could not be determined", error);
    return false;
  }
}

/**
 * Shows a notification, or reports that it did not.
 *
 * An empty title is refused rather than passed on: some platforms throw for it, and
 * a notification with no title is unreadable anyway.
 */
export function notify(payload: NotificationPayload): boolean {
  if (!canNotify()) return false;

  const title = payload.title.trim();
  if (title.length === 0) return false;

  try {
    new Notification({ title, body: payload.body }).show();
    return true;
  } catch (error) {
    console.warn("[native] notification could not be shown", error);
    return false;
  }
}

/**
 * The one global shortcut, and the rule that a taken one is never a crash.
 *
 * `globalShortcut.register` answers an already-owned accelerator by returning
 * `false`, and throws for a malformed one. Neither may take the app down: the
 * launcher is still reachable from the tray, so the failure is a warning that names
 * the accelerator and says where the fallback is.
 *
 * The registrar is a parameter — the same shape as Electron's `globalShortcut` —
 * so both failure paths are exercised by a unit test instead of by launching the app
 * and hoping another app already owns ⌥Space.
 */

/**
 * ⌥Space.
 *
 * Electron spells it `Alt+Space` on every platform, and macOS maps Alt to Option, so
 * one string is correct for all three. It is the conventional launcher accelerator,
 * which is also why it is the one most likely to be taken — hence the fallback.
 */
export const LAUNCHER_ACCELERATOR = "Alt+Space";

/** The slice of Electron's `globalShortcut` used here. */
export interface GlobalShortcutRegistrar {
  /** True when the accelerator was bound; false when someone else already owns it. */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface ShortcutDeps {
  readonly registrar: GlobalShortcutRegistrar;
  /** What the accelerator does. Here: toggle the launcher. */
  readonly onTrigger: () => void;
  /** Overridable so a test can name the accelerator it expects to see bound. */
  readonly accelerator?: string;
}

export interface ShortcutRegistration {
  /** False means the tray is the only way into the launcher this session. */
  readonly registered: boolean;
  /** Unbinds what was bound. A no-op when registration failed. */
  dispose(): void;
}

/**
 * Binds the accelerator, or explains why it could not be bound.
 *
 * Call after `ready`: Electron refuses to register a global shortcut before the app
 * is ready, and that refusal arrives as a throw, which is handled like any other
 * failure here.
 */
export function registerShortcuts(deps: ShortcutDeps): ShortcutRegistration {
  const accelerator = deps.accelerator ?? LAUNCHER_ACCELERATOR;

  let registered = false;
  try {
    registered = deps.registrar.register(accelerator, deps.onTrigger);
  } catch (error) {
    // A malformed accelerator, or a call before `ready`. Same outcome for the user as
    // "already taken", and equally not worth crashing for.
    console.warn(`[native] ${accelerator} could not be registered`, error);
    return { registered: false, dispose() {} };
  }

  if (!registered) {
    console.warn(
      `[native] ${accelerator} is already taken; the launcher stays reachable from the tray`,
    );
    return { registered: false, dispose() {} };
  }

  return {
    registered: true,
    dispose() {
      try {
        deps.registrar.unregister(accelerator);
      } catch (error) {
        // Quitting is not the moment to fail loudly over an accelerator.
        console.warn(`[native] ${accelerator} could not be unregistered`, error);
      }
    },
  };
}

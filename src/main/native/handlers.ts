/**
 * The native shell's wiring: one place that owns the launcher window, the shortcut,
 * the tray, and the deep-link listeners.
 *
 * Two exports, because they have different timing requirements:
 *
 *  - `registerNativeHandlers()` needs only `ipcMain`, so it can run with the rest of
 *    the IPC surface and does not care about window state.
 *  - `registerNativeAppHooks()` acquires the single-instance lock and registers the
 *    deep-link listeners immediately — macOS delivers `open-url` during launch, and a
 *    listener added after `ready` misses it — then defers the parts that need a ready
 *    app (the global shortcut, the tray) to `whenReady()` itself.
 *
 * Call `registerNativeAppHooks()` once, early, and do not wait on it. Its failure modes
 * are a warning and a degraded shell, never a thrown app: a taken ⌥Space or a platform
 * that refuses a tray icon still leaves a working app.
 *
 * `src/main/index.ts` is not edited by this slice. The orchestrator calls both, and
 * `registerNativeHandlers()` must come **after** `index.ts`'s `registerIpc()`: it
 * replaces that function's generic handler for `native.showLauncher` with the one that
 * actually shows the launcher.
 */
import type { ResponseOf } from "@shared/ipc-contract";
import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { type DeepLinkRegistration, registerDeepLinks } from "./deeplinks.js";
import { createLauncher, type Launcher, launcherPreloadPath, launcherUrl } from "./launcher.js";
import { registerShortcuts, type ShortcutRegistration } from "./shortcuts.js";
import { createTray, type TrayHandle } from "./tray.js";

/** `index.ts` namespaces every channel as `cleon:<name>`; this is that, for ours. */
const SHOW_LAUNCHER_CHANNEL = "cleon:native.showLauncher";

let launcher: Launcher | null = null;
let tray: TrayHandle | null = null;
let shortcuts: ShortcutRegistration | null = null;
let deepLinks: DeepLinkRegistration | null = null;
let appHooksRegistered = false;

/**
 * The one launcher window for the process.
 *
 * Created on first use and then kept, so a second ⌥Space is instant and whatever the
 * renderer has on screen survives a dismiss.
 */
function launcherWindow(): Launcher {
  if (launcher === null) {
    launcher = createLauncher({
      preloadPath: launcherPreloadPath(),
      url: launcherUrl(),
      // The tray's first item states the launcher's real state — including when a blur
      // dismissed it rather than the user.
      onVisibilityChange: (visible) => tray?.setLauncherVisible(visible),
    });
  }
  return launcher;
}

export function showLauncher(): void {
  launcherWindow().show();
}

function toggleLauncher(): void {
  launcherWindow().toggle();
}

/**
 * The window a deep link opens in.
 *
 * The launcher is excluded by identity: it is a palette over the app, not a place a
 * thread opens. Focused first, then a visible one, then the newest — `getAllWindows()`
 * is in creation order, so the newest open window is the last one.
 */
function targetWindow(): BrowserWindow | null {
  const palette = launcher?.current ?? null;
  const candidates = BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed() && window !== palette)
    .reverse();

  return (
    candidates.find((window) => window.isFocused()) ??
    candidates.find((window) => window.isVisible()) ??
    candidates[0] ??
    null
  );
}

/**
 * "New chat" from the tray: bring the app forward.
 *
 * It cannot start composing, and this slice must not invent a channel to do it — the
 * contract is frozen. When it is next bumped, `native.newChat` (or a renderer-side
 * command channel) lands here; see the handoff note.
 */
function focusTargetWindow(): void {
  const window = targetWindow();
  if (window === null || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export interface NativeHandlerDeps {
  /** Overrides what "show the launcher" means; defaults to the process-wide launcher. */
  readonly showLauncher?: () => void;
}

/**
 * Registers `native.showLauncher`.
 *
 * Call this **after** `index.ts`'s `registerIpc()`. That function registers a handler
 * for every channel in the contract, `native.showLauncher` included, so this module
 * does not own the only registration of the channel — it owns the *right* one.
 * `removeHandler` replaces whatever is there instead of throwing the way a second
 * `ipcMain.handle` on the same channel would, and it is a documented no-op when
 * nothing is registered. Wired in the other order, index.ts's generic handler would
 * be the one that answers.
 */
export function registerNativeHandlers(deps: NativeHandlerDeps = {}): void {
  const show = deps.showLauncher ?? showLauncher;

  ipcMain.removeHandler(SHOW_LAUNCHER_CHANNEL);
  ipcMain.handle(SHOW_LAUNCHER_CHANNEL, (): ResponseOf<"native.showLauncher"> => {
    show();
    return { ok: true };
  });
}

/**
 * Acquires the single-instance lock and wires the shell.
 *
 * Safe to call before or after `ready`: the lock and the deep-link listeners are
 * registered synchronously, the shortcut and the tray are deferred to `whenReady()`.
 */
export function registerNativeAppHooks(): void {
  if (appHooksRegistered) {
    console.warn("[native] app hooks are already registered; ignoring the second call");
    return;
  }
  appHooksRegistered = true;

  // First and synchronously: a second launch has to hand its argv to this process and
  // exit, not become a rival copy with its own SQLite file, tray, and shortcut.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  deepLinks = registerDeepLinks({ app, windowFor: targetWindow });

  app.on("will-quit", () => {
    deepLinks?.dispose();
    shortcuts?.dispose();
    tray?.destroy();
    launcher?.destroy();
  });

  void app.whenReady().then(() => {
    // ⌥Space. A taken accelerator is a warning and a tray item, never a failed start.
    shortcuts = registerShortcuts({
      registrar: globalShortcut,
      onTrigger: toggleLauncher,
    });

    try {
      tray = createTray({
        onToggleLauncher: toggleLauncher,
        onNewChat: focusTargetWindow,
        onQuit: () => app.quit(),
      });
    } catch (error) {
      // A platform that refuses a tray icon still gets the shortcut, and the reverse.
      console.warn("[native] tray unavailable; the launcher is still reachable", error);
      tray = null;
    }
  });
}

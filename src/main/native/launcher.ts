/**
 * The ⌥Space launcher: a frameless, always-on-top palette over the same bundle.
 *
 * It is a second *window*, never a second app instance — same process, same preload,
 * same sandbox posture as the main window. The renderer decides what `#launcher`
 * means; this module's only routing statement is the hash, so adding a real launcher
 * screen later needs no change here.
 *
 * Two deliberate choices, both about focus — a launcher that fights for focus is
 * worse than no launcher:
 *
 *  - The window is created on first use, not at startup. A hidden always-on-top
 *    renderer is a whole extra process for a window most sessions never open. It is
 *    still created with `show: false` and revealed deliberately, so the palette never
 *    flashes as an empty rectangle: a toggle before the first paint waits for
 *    `ready-to-show`.
 *  - Only an explicit `toggle()` shows it, and a blur hides it. Nothing here reacts
 *    to keystrokes or re-focuses on a timer, so a press can never interrupt typing in
 *    another app.
 */
import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

const LAUNCHER_WIDTH = 680;
const LAUNCHER_HEIGHT = 460;

/**
 * The bundle's own background, so the first frame of a frameless window is not a
 * white flash while the renderer paints.
 */
const LAUNCHER_BACKGROUND = "#0b0d12";

export interface LauncherOptions {
  /** The bundled preload, as an absolute path. */
  readonly preloadPath: string;
  /** `app://bundle/index.html#launcher`, or the dev server URL with the same hash. */
  readonly url: string;
  /** Called whenever the window becomes or stops being on screen. */
  readonly onVisibilityChange?: (visible: boolean) => void;
}

export interface Launcher {
  /** Creates the window on first call; shows and focuses it. */
  show(): void;
  hide(): void;
  /** ⌥Space: dismiss when it is in front, otherwise bring it forward. */
  toggle(): void;
  isVisible(): boolean;
  /** The live window, or `null` before the first `show()`. */
  readonly current: BrowserWindow | null;
  destroy(): void;
}

export function createLauncher(options: LauncherOptions): Launcher {
  let window: BrowserWindow | null = null;
  /** True once the renderer has painted at least once. */
  let paintable = false;
  /** A `show()` arrived before the first paint; reveal as soon as there is one. */
  let revealOnPaint = false;

  function present(target: BrowserWindow): void {
    // "floating" keeps the palette above ordinary windows without covering the menu
    // bar, which is the level a dictionary-style popover belongs at.
    target.setAlwaysOnTop(true, "floating");
    target.show();
    target.focus();
  }

  function create(): BrowserWindow {
    const created = new BrowserWindow({
      width: LAUNCHER_WIDTH,
      height: LAUNCHER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: LAUNCHER_BACKGROUND,
      // The same hardened posture as the main window (invariant 1). The launcher is
      // another viewer of the same contract, not a more privileged one; it shares the
      // preload, so it exposes exactly the same bridge and nothing more.
      webPreferences: {
        preload: options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: false,
      },
    });

    created.once("ready-to-show", () => {
      paintable = true;
      if (revealOnPaint) {
        revealOnPaint = false;
        present(created);
      }
    });

    created.on("show", () => options.onVisibilityChange?.(true));
    created.on("hide", () => options.onVisibilityChange?.(false));

    // A palette that stays up when the user looks elsewhere is in the way.
    created.on("blur", () => {
      if (!created.isDestroyed()) created.hide();
    });

    created.on("closed", () => {
      window = null;
      paintable = false;
      revealOnPaint = false;
    });

    // Nothing here navigates either. Only the protocol the window was launched with is
    // allowed to be a navigation target; everything https goes to the real browser.
    const launchProtocol = new URL(options.url).protocol;
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    created.webContents.on("will-navigate", (event, url) => {
      if (URL.canParse(url) && new URL(url).protocol === launchProtocol) return;
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    });

    void created.loadURL(options.url);
    return created;
  }

  function ensure(): BrowserWindow {
    if (window !== null && !window.isDestroyed()) return window;
    window = create();
    return window;
  }

  // A named function rather than a method, so `toggle` does not depend on `this` and
  // a destructured `const { toggle } = launcher` still works.
  function reveal(): void {
    const target = ensure();
    if (target.isVisible() || paintable) {
      present(target);
      return;
    }
    // First open: wait for the paint rather than showing an empty rectangle.
    revealOnPaint = true;
  }

  return {
    get current(): BrowserWindow | null {
      return window !== null && !window.isDestroyed() ? window : null;
    },

    show: reveal,

    hide(): void {
      if (window !== null && !window.isDestroyed()) window.hide();
    },

    toggle(): void {
      const target = ensure();
      // Visible *and* focused means the palette is what the user is looking at, so
      // the same key dismisses it. Visible but not focused — another space, another
      // app in front — means this press should bring it forward, not hide it.
      if (target.isVisible() && target.isFocused()) {
        target.hide();
        return;
      }
      reveal();
    },

    isVisible(): boolean {
      return window !== null && !window.isDestroyed() && window.isVisible();
    },

    destroy(): void {
      if (window !== null && !window.isDestroyed()) window.destroy();
      window = null;
      paintable = false;
      revealOnPaint = false;
    },
  };
}

/**
 * Where the launcher loads from, mirroring `src/main/index.ts`.
 *
 * The dev server when one is running, the privileged bundle otherwise. Both carry
 * the same `#launcher` hash: the route belongs to the renderer, and this slice does
 * not own (or add) a renderer entry point.
 */
export function launcherUrl(): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) return `${devUrl}#launcher`;
  return "app://bundle/index.html#launcher";
}

/** The bundled preload, resolved the same way `src/main/index.ts` resolves it. */
export function launcherPreloadPath(): string {
  return join(import.meta.dirname, "../preload/index.cjs");
}

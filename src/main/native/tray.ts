/**
 * The tray: the way back into the launcher when ⌥Space is taken, and the one place
 * Quit lives.
 *
 * The icon is a title, not an asset. A template PNG for a glyph macOS would render
 * as a menu-bar title anyway means committing a binary to the repo (or synthesising
 * one from base64 at startup), so the tray is built from an empty image plus
 * `setTitle` and nothing is committed. That trade is macOS-specific: Windows and
 * Linux draw no menu-bar text, so those platforms need a real 16×16 icon before this
 * ships there — see the handoff note.
 *
 * The first item follows the launcher: "Show launcher" when it is hidden, "Hide
 * launcher" when it is up. A menu that lies about state is the kind of small wrong
 * thing that makes a shell feel unfinished.
 */
import type { MenuItemConstructorOptions } from "electron";
import { Menu, nativeImage, Tray } from "electron";

export interface TrayDeps {
  /** The launcher, in menu form. */
  readonly onToggleLauncher: () => void;
  /**
   * "New chat". The frozen contract has no channel for "start composing", so the
   * best this slice can do is bring the app forward; the call site is where a future
   * `native.newChat` lands.
   */
  readonly onNewChat: () => void;
  readonly onQuit: () => void;
}

export interface TrayHandle {
  /** Rebuilds the menu so the first item reflects the launcher's real state. */
  setLauncherVisible(visible: boolean): void;
  destroy(): void;
}

export function createTray(deps: TrayDeps): TrayHandle {
  const tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Cleon");
  // macOS only, which is exactly why the other platforms need a real icon: this one
  // line is the whole of the tray's appearance there.
  if (process.platform === "darwin") tray.setTitle("Cleon");

  let launcherVisible = false;

  const render = (): void => {
    const template: MenuItemConstructorOptions[] = [
      {
        label: launcherVisible ? "Hide launcher" : "Show launcher",
        click: () => deps.onToggleLauncher(),
      },
      { type: "separator" },
      { label: "New chat", click: () => deps.onNewChat() },
      { type: "separator" },
      { label: "Quit Cleon", click: () => deps.onQuit() },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  render();

  return {
    setLauncherVisible(visible: boolean): void {
      if (visible === launcherVisible) return;
      launcherVisible = visible;
      render();
    },

    destroy(): void {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GlobalShortcutRegistrar,
  LAUNCHER_ACCELERATOR,
  registerShortcuts,
} from "../../src/main/native/shortcuts.js";

/**
 * ⌥Space, and the rule that losing it is not a crash.
 *
 * `globalShortcut` only exists inside Electron, so the module takes a registrar with
 * the same shape. That is what makes these assertions possible at all: the two ways
 * registration fails — the accelerator is owned by another app, and the platform
 * refuses the call — are the interesting paths, and neither can be produced on demand
 * in a unit test otherwise.
 */

interface FakeRegistrar extends GlobalShortcutRegistrar {
  readonly bound: Map<string, () => void>;
  readonly unregistered: string[];
}

function createRegistrar(behaviour: { owned?: boolean; refuse?: Error } = {}): FakeRegistrar {
  const bound = new Map<string, () => void>();
  const unregistered: string[] = [];

  return {
    bound,
    unregistered,
    register(accelerator, callback) {
      if (behaviour.refuse) throw behaviour.refuse;
      if (behaviour.owned) return false;
      bound.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      unregistered.push(accelerator);
      bound.delete(accelerator);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerShortcuts", () => {
  it("binds ⌥Space to the trigger and says so", () => {
    const registrar = createRegistrar();
    const onTrigger = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const shortcut = registerShortcuts({ registrar, onTrigger });

    expect(shortcut.registered).toBe(true);
    expect([...registrar.bound.keys()]).toEqual([LAUNCHER_ACCELERATOR]);
    expect(warn).not.toHaveBeenCalled();

    // The bound callback is the trigger, not a wrapper that forgets to call it.
    registrar.bound.get(LAUNCHER_ACCELERATOR)?.();
    expect(onTrigger).toHaveBeenCalledTimes(1);

    shortcut.dispose();
    expect(registrar.unregistered).toEqual([LAUNCHER_ACCELERATOR]);
  });

  it("survives an accelerator another app already owns", () => {
    const registrar = createRegistrar({ owned: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const shortcut = registerShortcuts({ registrar, onTrigger: () => undefined });

    expect(shortcut.registered).toBe(false);
    // Surfaced as a warning that names the accelerator and the way in that remains,
    // because a silently dead launcher shortcut is indistinguishable from a bug.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).toContain(LAUNCHER_ACCELERATOR);
    expect(warn.mock.calls[0]?.join(" ")).toContain("tray");

    // Nothing was bound, so nothing may be unbound, and disposing must not throw.
    expect(() => shortcut.dispose()).not.toThrow();
    expect(registrar.unregistered).toEqual([]);
  });

  it("survives a registrar that throws", () => {
    // `globalShortcut.register` throws for a malformed accelerator and for a call
    // before `ready`. Either would otherwise take the whole app down at startup.
    const registrar = createRegistrar({ refuse: new Error("before ready") });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const shortcut = registerShortcuts({ registrar, onTrigger: () => undefined });

    expect(shortcut.registered).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => shortcut.dispose()).not.toThrow();
  });

  it("binds the accelerator it was given", () => {
    const registrar = createRegistrar();

    const shortcut = registerShortcuts({
      registrar,
      onTrigger: () => undefined,
      accelerator: "CommandOrControl+Shift+Space",
    });

    expect(shortcut.registered).toBe(true);
    expect([...registrar.bound.keys()]).toEqual(["CommandOrControl+Shift+Space"]);
  });
});

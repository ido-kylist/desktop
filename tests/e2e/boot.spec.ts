import { _electron as electron, expect, test } from "@playwright/test";

/**
 * G0 proof. Launches the built app exactly as a user would and asserts the three
 * things D0 exists to establish: the window boots, the renderer completes the
 * protocol handshake over the preload bridge, and the main process reaches
 * SQLite with the FTS5 index available.
 */
test("boots, handshakes, reaches sqlite", async () => {
  const app = await electron.launch({ args: ["."] });

  try {
    const win = await app.firstWindow();
    await expect(win).toHaveTitle("Cleon");

    // Bridge present + protocol versions agree. The number is read from the
    // bridge rather than written here, so a version bump is not an e2e edit.
    const protocol = await win.evaluate(
      () =>
        (globalThis as unknown as { cleon: { readonly protocolVersion: number } }).cleon
          .protocolVersion,
    );
    await expect(win.getByText(`protocol v${protocol} handshake OK`)).toBeVisible({
      timeout: 20_000,
    });

    // Main reached SQLite with the FTS5 virtual table. The schema version is read
    // from the bridge rather than hardcoded: migrations land over time, and a
    // literal here turns every migration into an unrelated test failure.
    await expect(win.getByText("available")).toBeVisible({ timeout: 20_000 });
    const schemaVersion = await win.evaluate(async () => {
      const res = await (
        globalThis as unknown as {
          cleon: {
            invoke: (
              c: string,
              p: object,
            ) => Promise<{ ok: boolean; data?: { schemaVersion: number } }>;
          };
        }
      ).cleon.invoke("db.health", {});
      return res.ok ? res.data?.schemaVersion : -1;
    });
    expect(schemaVersion).toBeGreaterThanOrEqual(2);
    await expect(win.getByText(`v${schemaVersion}`, { exact: true })).toBeVisible();

    // A real IPC round trip, not just a static render.
    await win.getByRole("button", { name: "Send ping" }).click();
    await expect(win.locator(".pings li")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

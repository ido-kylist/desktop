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

    // Bridge present + protocol versions agree.
    await expect(win.getByText(/protocol v1 handshake OK/)).toBeVisible({ timeout: 20_000 });

    // Main reached SQLite and applied schema v1 with the FTS5 virtual table.
    await expect(win.getByText("available")).toBeVisible({ timeout: 20_000 });
    await expect(win.getByText("v1", { exact: true })).toBeVisible();

    // A real IPC round trip, not just a static render.
    await win.getByRole("button", { name: "Send ping" }).click();
    await expect(win.locator(".pings li")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

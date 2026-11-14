import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Runs only when CLEON_PACKAGED_APP points at an installed .app bundle, e.g.
 *
 *   hdiutil attach release/Cleon-0.1.0-arm64.dmg -mountpoint /tmp/cleon-mnt -nobrowse
 *   cp -R /tmp/cleon-mnt/Cleon.app /tmp/cleon-dmg/
 *   CLEON_PACKAGED_APP=/tmp/cleon-dmg/Cleon.app npx playwright test tests/e2e/packaged.spec.ts
 *
 * This is the difference between "it builds" and "it runs after install": the
 * asar packing, the app:// scheme inside a bundle, and the native module all have
 * to survive packaging, and this is where that is checked.
 */
test.skip(!process.env.CLEON_PACKAGED_APP, "set CLEON_PACKAGED_APP to test an installed bundle");

test("installed bundle boots, handshakes and reaches sqlite", async () => {
  const bundle = process.env.CLEON_PACKAGED_APP as string;

  const app = await electron.launch({
    executablePath: `${bundle}/Contents/MacOS/Cleon`,
    args: [],
  });

  try {
    const win = await app.firstWindow();
    await expect(win).toHaveTitle("Cleon");
    const protocol = await win.evaluate(
      () =>
        (globalThis as unknown as { cleon: { readonly protocolVersion: number } }).cleon
          .protocolVersion,
    );
    await expect(win.getByText(`protocol v${protocol} handshake OK`)).toBeVisible({
      timeout: 25_000,
    });
    await expect(win.getByText("packaged")).toBeVisible();
    await expect(win.getByText("available")).toBeVisible({ timeout: 20_000 });

    await win.getByRole("button", { name: "Send ping" }).click();
    await expect(win.locator(".pings li")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

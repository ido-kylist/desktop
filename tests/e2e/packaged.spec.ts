import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Runs only when CLEON_PACKAGED_APP points at an installed .app bundle:
 *
 *   hdiutil attach release/Cleon-0.1.0-arm64.dmg -mountpoint /tmp/cleon-mnt -nobrowse
 *   cp -R /tmp/cleon-mnt/Cleon.app /tmp/cleon-rel/
 *   CLEON_PACKAGED_APP=/tmp/cleon-rel/Cleon.app npx playwright test tests/e2e/packaged.spec.ts
 *
 * This is the difference between "it builds" and "it works after install": the asar
 * packing, the app:// scheme inside a bundle, the native module, and a real chat turn
 * all have to survive packaging. G11's gate is exactly this.
 */
test.skip(!process.env.CLEON_PACKAGED_APP, "set CLEON_PACKAGED_APP to test an installed bundle");

const PORT = 4795;
const BASE = `http://127.0.0.1:${PORT}`;

let mock: ChildProcess | undefined;
let userData: string;

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "cleon-packaged-"));
  mock = spawn(process.execPath, ["mock/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), FRAME_DELAY_MS: "0" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  mock?.kill();
  if (userData) await rm(userData, { recursive: true, force: true });
});

test("installed bundle boots, handshakes, reaches sqlite", async () => {
  const bundle = process.env.CLEON_PACKAGED_APP as string;
  const app = await electron.launch({
    executablePath: `${bundle}/Contents/MacOS/Cleon`,
    args: [],
    env: { ...process.env, CLEON_API_BASE: BASE, CLEON_USER_DATA: userData },
  });

  try {
    const win = await app.firstWindow();
    await expect(win).toHaveTitle("Cleon");

    const protocol = await win.evaluate(
      () => (globalThis as unknown as { cleon: { protocolVersion: number } }).cleon.protocolVersion,
    );
    await expect(win.getByText(`protocol v${protocol} handshake OK`)).toBeVisible({
      timeout: 25_000,
    });
    await expect(win.getByText("available")).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test("installed bundle completes a chat turn against the mock", async () => {
  const bundle = process.env.CLEON_PACKAGED_APP as string;
  const app = await electron.launch({
    executablePath: `${bundle}/Contents/MacOS/Cleon`,
    args: [],
    env: { ...process.env, CLEON_API_BASE: BASE, CLEON_USER_DATA: userData },
  });

  try {
    const win = await app.firstWindow();
    const composer = win.getByLabel("Message");
    await expect(composer).toBeVisible({ timeout: 25_000 });

    await composer.fill("hello from the packaged app");
    await composer.press("Enter");

    // A real stream, not a static render: the mock says exactly this.
    await expect(win.getByText("Hello from the mock.")).toBeVisible({ timeout: 25_000 });

    // And it was persisted, not just painted.
    await expect(win.getByTestId("thread-row").first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

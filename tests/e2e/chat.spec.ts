import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * Gate G1, at the UI: send → stream → quit → relaunch restores.
 *
 * The app is launched exactly as a user launches it (`args: ["."]`, the built
 * `out/main/index.js`), pointed at the mock server with `CLEON_API_BASE` and given a
 * throwaway `CLEON_USER_DATA` so the SQLite file and Chromium storage are this test's
 * alone. The relaunch leg reuses that same directory — that is the whole claim.
 *
 * No protocol literals appear here: the version is never asserted, only used by the
 * app. The one non-negotiable string is the mock's answer, which is the fixture.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

/** Slow enough that Stop is observable mid-answer; the text fixture is 7 frames. */
const FRAME_DELAY_MS = 150;

let mock: ChildProcess | undefined;
let base = "";
const userDataDirs: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe: Server = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      probe.close((error) => {
        if (error) rejectPort(error);
        else if (port === 0) rejectPort(new Error("could not reserve a port"));
        else resolvePort(port);
      });
    });
  });
}

async function waitForHealth(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("mock server did not become healthy");
}

async function makeUserData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cleon-d1c-"));
  userDataDirs.push(dir);
  return dir;
}

/** `process.env` may hold `undefined`; Playwright's `env` wants strings only. */
function appEnv(userData: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.CLEON_API_BASE = base;
  env.CLEON_USER_DATA = userData;
  return env;
}

async function launch(userData: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: ["."], env: appEnv(userData) });
  const win = await app.firstWindow();
  await expect(win).toHaveTitle("Cleon");
  return { app, win };
}

/** Sends a message and waits for the whole turn to finish (Stop appears, then goes). */
async function sendAndWait(win: Page, text: string): Promise<void> {
  await win.getByLabel("Message").fill(text);
  await win.getByLabel("Message").press("Enter");

  const stop = win.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await expect(stop).toHaveCount(0, { timeout: 20_000 });
}

/** Distance from the bottom of the transcript, in CSS pixels. */
async function transcriptScroll(win: Page): Promise<{ top: number; bottom: number }> {
  return win.locator(".transcript").evaluate((element) => ({
    top: Math.round(element.scrollTop),
    bottom: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
  }));
}

test.beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  mock = spawn(process.execPath, ["mock/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), FRAME_DELAY_MS: String(FRAME_DELAY_MS) },
    stdio: "ignore",
  });
  await waitForHealth();
});

test.afterAll(async () => {
  mock?.kill();
  await Promise.all(userDataDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("streams an answer, then restores the thread after a relaunch", async () => {
  const userData = await makeUserData();

  const first = await launch(userData);
  try {
    const composer = first.win.getByLabel("Message");
    await composer.fill("hi");
    await composer.press("Enter");

    // Stop exists only while a generation is live.
    const stop = first.win.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible({ timeout: 15_000 });

    await expect(first.win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });
    await expect(stop).toHaveCount(0, { timeout: 20_000 });
    await expect(first.win.getByText("hi", { exact: true })).toBeVisible();
  } finally {
    await first.app.close();
  }

  // The same user-data directory: the same database and the same remembered thread.
  const second = await launch(userData);
  try {
    await expect(second.win.getByText("hi", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(second.win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });
  } finally {
    await second.app.close();
  }
});

test("stops an in-flight generation without surfacing an error", async () => {
  const userData = await makeUserData();
  const { app, win } = await launch(userData);

  try {
    await win.getByLabel("Message").fill("count to a hundred");
    await win.getByLabel("Message").press("Enter");

    const stop = win.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible({ timeout: 15_000 });
    await stop.click();

    await expect(stop).toHaveCount(0, { timeout: 15_000 });
    // A stop is a normal end, not a failure: no banner, no error code.
    await expect(win.getByTestId("error-banner")).toHaveCount(0);
    await expect(win.getByText("count to a hundred", { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("shows the budget banner without a retry affordance", async () => {
  const userData = await makeUserData();
  const { app, win } = await launch(userData);

  try {
    await win.getByLabel("Model").fill("mock/402");
    await win.getByLabel("Message").fill("expensive");
    await win.getByLabel("Message").press("Enter");

    const banner = win.getByTestId("error-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    // The contract's code and the upstream message, not a generic string.
    await expect(banner).toContainText("BUDGET_EXCEEDED");
    await expect(banner).toContainText("Monthly budget exhausted. Top up to continue.");

    // Retrying cannot help until the budget changes, so the affordance is absent.
    await expect(win.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(win.getByRole("button", { name: "Stop" })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("retries a retryable failure with the same user text", async () => {
  const userData = await makeUserData();
  const { app, win } = await launch(userData);

  try {
    await win.getByLabel("Model").fill("mock/truncated");
    await win.getByLabel("Message").fill("tell me everything");
    await win.getByLabel("Message").press("Enter");

    const banner = win.getByTestId("error-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("UPSTREAM_TRUNCATED");

    const retry = win.getByRole("button", { name: "Retry" });
    await expect(retry).toBeEnabled();
    await retry.click();

    // The retry is a new turn carrying the same user text, not a silent resend.
    await expect(win.getByText("tell me everything", { exact: true })).toHaveCount(2, {
      timeout: 20_000,
    });
    await expect(banner).toContainText("UPSTREAM_TRUNCATED", { timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test("counts down a rate limit before allowing a retry", async () => {
  const userData = await makeUserData();
  const { app, win } = await launch(userData);

  try {
    await win.getByLabel("Model").fill("mock/429");
    await win.getByLabel("Message").fill("again");
    await win.getByLabel("Message").press("Enter");

    const banner = win.getByTestId("error-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("RATE_LIMITED");
    // The mock sends `retry-after: 7`, so the wait is on screen and Retry is held back
    // until it elapses — a distinct state from a plain retryable failure.
    await expect(banner).toContainText("Retry in");
    await expect(win.getByRole("button", { name: "Retry" })).toBeDisabled();
  } finally {
    await app.close();
  }
});

test("follows the stream until the reader scrolls away, then resumes", async () => {
  const userData = await makeUserData();
  const { app, win } = await launch(userData);

  try {
    // A short window, so a handful of turns actually overflow the transcript.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1000, 460);
    });

    for (let index = 1; index <= 4; index += 1) await sendAndWait(win, `message ${index}`);

    // A live answer leaves the view pinned to the bottom.
    await expect.poll(async () => (await transcriptScroll(win)).bottom).toBeLessThanOrEqual(2);

    await win.locator(".transcript").evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect.poll(async () => (await transcriptScroll(win)).top).toBe(0);

    await sendAndWait(win, "while reading up here");
    // Following is off: the answer must not yank the view back down.
    expect((await transcriptScroll(win)).top).toBeLessThanOrEqual(2);

    await win.locator(".transcript").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await sendAndWait(win, "back at the bottom");

    // Scrolling back to the bottom resumes following.
    await expect.poll(async () => (await transcriptScroll(win)).bottom).toBeLessThanOrEqual(2);
  } finally {
    await app.close();
  }
});

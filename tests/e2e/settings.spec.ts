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
 * P0 at the UI: a provider is configured in Settings and the rest of the app uses it.
 *
 * The mock server is this test's provider, started on a free port. `CLEON_API_BASE` is
 * deliberately *not* set: the URL typed into Settings has to be the thing that makes
 * the model list and the chat turn work, otherwise this would only prove that an
 * environment variable reaches the app.
 *
 * A throwaway `CLEON_USER_DATA` keeps the SQLite file and the stored settings out of
 * the developer's profile, exactly as `chat.spec.ts` does.
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
  const dir = await mkdtemp(join(tmpdir(), "cleon-p0-"));
  userDataDirs.push(dir);
  return dir;
}

/** `process.env` may hold `undefined`; Playwright's `env` wants strings only. */
function appEnv(userData: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // No CLEON_API_BASE: the endpoint under test is the one saved in Settings.
  delete env.CLEON_API_BASE;
  env.CLEON_USER_DATA = userData;
  return env;
}

async function launch(userData: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: ["."], env: appEnv(userData) });
  const win = await app.firstWindow();
  await expect(win).toHaveTitle("Cleon");
  return { app, win };
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

/**
 * FIXME: the renderer half is implemented and unit-tested, but `feat/p0` froze the
 * channels before the main-process handlers exist. On this branch the `handlers` map in
 * `src/main/index.ts` has no `settings.get`, `settings.set` or `models.list` entry, so
 * every call to one of them answers a failed envelope: the observed run below showed
 * the Settings screen's load error — `INTERNAL handler is not a function` — instead of
 * the form, and failed at the first assertion.
 *
 * The same gap disables the composer's model select (`models.list` never succeeds), so
 * `chat.spec.ts`'s three `selectOption` tests fail on this branch too. Both go green
 * when the main-process worker's handlers land; nothing here is test-side to fix.
 *
 * Remove the `.fixme` at that point: this test is then the acceptance test for the
 * slice.
 */
test.fixme(
  "saves a provider endpoint, lists its models, and streams a turn against it",
  async () => {
    const userData = await makeUserData();
    const { app, win } = await launch(userData);

    try {
      await win.getByTestId("open-settings").click();
      await expect(win.getByTestId("settings")).toBeVisible();

      // A fresh profile has no key, and the screen says what that means upstream.
      await expect(win.getByTestId("key-missing")).toContainText("will not send one");

      // Save the endpoint the app must now use. The field starts empty on a fresh profile.
      await win.getByLabel("Base URL").fill(base);
      await win.getByTestId("save-base-url").click();
      await expect(win.getByTestId("base-url-saved")).toBeVisible();

      // The model list is the endpoint's answer, not a constant.
      await expect(win.getByTestId("model-select")).toContainText("mock/text", { timeout: 15_000 });
      await win.getByLabel("Default model").selectOption("mock/text");

      // Test connection: the count, and the source said honestly.
      await win.getByTestId("test-connection").click();
      const connection = win.getByTestId("connection-result");
      await expect(connection).toContainText("models available", { timeout: 15_000 });
      await expect(connection).toContainText("Read from the configured endpoint");

      await win.getByTestId("settings-done").click();

      // The composer's picker is the same catalogue, and the chosen model survived.
      await expect(win.getByLabel("Model")).toHaveValue("mock/text");

      // The turn streams through the configured endpoint. If the base URL were not in
      // effect, this would go to the unpackaged default and never answer.
      await win.getByLabel("Message").fill("hi");
      await win.getByLabel("Message").press("Enter");

      const stop = win.getByRole("button", { name: "Stop" });
      await expect(stop).toBeVisible({ timeout: 15_000 });
      await expect(win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });
      await expect(stop).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await app.close();
    }
  },
);

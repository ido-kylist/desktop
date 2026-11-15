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
 * D2 at the UI: two threads, then a search that narrows the sidebar to one of them.
 *
 * The app is launched exactly as a user launches it (`args: ["."]`, the built
 * `out/main/index.js`), pointed at the mock server with `CLEON_API_BASE` and given a
 * throwaway `CLEON_USER_DATA`, the same way `tests/e2e/chat.spec.ts` does.
 *
 * The search assertion is deliberately not "a row disappeared": it clicks the one row
 * that is left and checks the transcript that opens. A narrowing that kept the wrong
 * thread would pass a count assertion and fail the user.
 *
 * The sidebar talks to `threads.list` / `threads.update` / `threads.delete`, which main
 * implements on `feat/d2d3-platform` — this branch is based on that tip, so the run is a
 * real one. Every state asserted here is reached through the app's own UI.
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
  const dir = await mkdtemp(join(tmpdir(), "cleon-d2-"));
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

test("narrows the sidebar to one thread when searching", async () => {
  const userData = await makeUserData();
  const { app, win } = await launch(userData);

  try {
    // Thread one: a message only this thread contains.
    await sendAndWait(win, "a first thread about otters");
    // The turn really answered, not just persisted: the mock's fixture text.
    await expect(win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });
    await expect(win.getByTestId("thread-row")).toHaveCount(1, { timeout: 20_000 });

    // Thread two: a new chat, then a different message.
    await win.getByTestId("new-chat").click();
    await sendAndWait(win, "a second thread about herons");
    await expect(win.getByTestId("thread-row")).toHaveCount(2, { timeout: 20_000 });

    // Search is the server's FTS5, not a client-side filter: typing narrows the list.
    // The content assertion comes first: a count of one would also be satisfied by the
    // previous search's single row, before the debounced query has even fired.
    const search = win.getByTestId("thread-search");
    const rows = win.getByTestId("thread-row");
    const transcript = win.locator(".transcript");

    await search.fill("herons");
    await expect(rows.filter({ hasText: "herons" })).toHaveCount(1, { timeout: 20_000 });
    await expect(rows).toHaveCount(1, { timeout: 20_000 });

    // The snippet's brackets are highlighting, not characters on screen.
    const snippet = rows.locator(".thread-snippet");
    await expect(snippet.locator("mark")).toContainText("herons");
    await expect(snippet).not.toContainText("[");

    // The row that survived is the right thread, proven by opening it. Scoped to the
    // transcript: the search snippet quotes the same words.
    await rows.click();
    await expect(transcript.getByText("a second thread about herons", { exact: true })).toBeVisible(
      {
        timeout: 20_000,
      },
    );

    await search.fill("otters");
    await expect(rows.filter({ hasText: "otters" })).toHaveCount(1, { timeout: 20_000 });
    await expect(rows).toHaveCount(1, { timeout: 20_000 });
    await rows.click();
    await expect(transcript.getByText("a first thread about otters", { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    // A term nothing contains is an empty list, said plainly.
    await search.fill("wombats");
    await expect(rows).toHaveCount(0, { timeout: 20_000 });
    await expect(win.getByTestId("thread-list-empty")).toBeVisible();
  } finally {
    await app.close();
  }
});

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
 * D8's artifacts panel at the UI: create, append a version, and go back to an old one.
 *
 * The claim is the one the panel exists for — **a save appends**. Version 1's text has to
 * still be there after version 2 is written, readable through the switcher, and read-only
 * (because a form that could overwrite it would make the switcher a lie). The storage layer
 * proves the same thing in `tests/integration/artifacts.spec.ts`; this proves the panel wires
 * the buttons to it, which is the part no unit test can see.
 *
 * A message has to be sent first: an artifact belongs to a thread, and a fresh profile has no
 * thread for one to belong to. That is also the panel's "no thread yet" state, asserted before
 * the send.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MOCK_SERVER = resolve(ROOT, "mock/server.mjs");

let mock: ChildProcess | undefined;
let base = "";
let app: ElectronApplication | undefined;
let workDir = "";
let userData = "";

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

/** `process.env` may hold `undefined`; Playwright's `env` wants strings only. */
function appEnv(directory: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.CLEON_API_BASE = base;
  env.CLEON_USER_DATA = directory;
  return env;
}

async function launch(directory: string): Promise<{ app: ElectronApplication; win: Page }> {
  const launched = await electron.launch({ args: ["."], env: appEnv(directory) });
  const win = await launched.firstWindow();
  await expect(win).toHaveTitle("Cleon");
  return { app: launched, win };
}

test.beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mock = spawn(process.execPath, [MOCK_SERVER], {
    env: { ...process.env, PORT: String(port), FRAME_DELAY_MS: "5" },
    stdio: "ignore",
  });
  await waitForHealth();

  workDir = await mkdtemp(join(tmpdir(), "cleon-d8-art-e2e-"));
  userData = join(workDir, "userdata");
});

test.afterAll(async () => {
  mock?.kill();
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

test("a save appends a version, and an old one is still readable afterwards", async () => {
  const launched = await launch(userData);
  app = launched.app;
  const win = launched.win;

  try {
    // 1. With no thread, the panel says so instead of offering a Save it would refuse.
    await win.getByTestId("open-artifacts").click();
    await expect(win.getByTestId("artifacts-panel")).toBeVisible();
    await expect(win.getByTestId("artifacts-no-thread")).toBeVisible();
    await win.getByTestId("artifacts-close").click();

    // 2. A thread to file the artifact under.
    await win.getByTestId("composer-model").selectOption("mock/text");
    await win.getByLabel("Message").fill("start a thread");
    await win.getByRole("button", { name: "Send", exact: true }).click();
    await expect(win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });

    // 3. Version 1.
    await win.getByTestId("open-artifacts").click();
    await expect(win.getByTestId("artifacts-list-empty")).toBeVisible();
    await win.getByTestId("artifact-new").click();
    await win.getByTestId("artifact-title").fill("Runbook");
    await win.getByTestId("artifact-content-input").fill("first draft");
    await win.getByTestId("artifact-save").click();

    await expect(win.getByTestId("artifact-saved")).toHaveText("Saved v1.");
    await expect(win.getByTestId("artifact-row").first()).toContainText("Runbook");
    await expect(win.getByTestId("artifact-row-version").first()).toHaveText("v1");

    // 4. Version 2, from the editor the save left in place.
    await win.getByTestId("artifact-content-input").fill("second draft");
    await win.getByTestId("artifact-save").click();

    await expect(win.getByTestId("artifact-saved")).toHaveText("Saved v2.");
    await expect(win.getByTestId("artifact-version")).toHaveCount(2);

    // 5. Back to version 1: read-only, and its text is the text it was written with. This is
    //    the assertion the whole feature is for.
    await win.getByTestId("artifact-version").first().click();
    const old = win.getByTestId("artifact-old-version");
    await expect(old).toBeVisible();
    await expect(old).toContainText("first draft");
    await expect(old).not.toContainText("second draft");
    // The editor is gone while an old version is on screen, so nothing can silently overwrite
    // it; "Back to latest" is the way out.
    await expect(win.getByTestId("artifact-content-input")).toHaveCount(0);

    await win.getByTestId("artifact-back-latest").click();
    await expect(win.getByTestId("artifact-content-input")).toHaveValue("second draft");
  } finally {
    await app?.close();
    app = undefined;
  }
});

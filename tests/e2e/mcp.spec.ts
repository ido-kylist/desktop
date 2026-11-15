import { mkdtemp, rm } from "node:fs/promises";
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
 * D7 at the UI: the approval card is a gate, not a progress bar.
 *
 * The claim this test exists to prove is negative, which is why it is end to end rather
 * than a component test: after a call is requested, the card shows Allow and Deny, and
 * **no result exists anywhere on screen** until Allow is pressed. A unit test can only say
 * "the card renders"; this one says the tool did not run — because the only thing that
 * makes it run is the button, and the echoed arguments appear in the result only after it.
 *
 * Then the same call denied: the record says `denied`, and there is still no result,
 * because a denial never reaches the server.
 *
 * The child process is the real mock from `mock/mcp-echo-server.mjs`, spawned by the app's
 * own manager with no shell, exactly as a user's server would be.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const ECHO_SERVER = resolve(ROOT, "mock/mcp-echo-server.mjs");

/** The arguments that must make the round trip, and must not appear before they do. */
const ARGUMENTS = '{"text": "approval please", "n": 7}';

let app: ElectronApplication | undefined;
let userData = "";

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "cleon-d7-e2e-"));
});

test.afterAll(async () => {
  if (userData !== "") await rm(userData, { recursive: true, force: true });
});

/** `process.env` may hold `undefined`; Playwright's `env` wants strings only. */
function appEnv(directory: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.CLEON_USER_DATA = directory;
  return env;
}

async function launch(directory: string): Promise<{ app: ElectronApplication; win: Page }> {
  const launched = await electron.launch({ args: ["."], env: appEnv(directory) });
  const win = await launched.firstWindow();
  await expect(win).toHaveTitle("Cleon");
  return { app: launched, win };
}

test("an approval blocks the call until Allow, and Deny leaves a visible record", async () => {
  const launched = await launch(userData);
  app = launched.app;
  const win = launched.win;

  try {
    // 1. The panel, and a server in it. `process.execPath` is a real node binary; the mock
    //    is a real script. Adding it starts nothing.
    await win.getByTestId("open-mcp").click();
    await expect(win.getByTestId("mcp-panel")).toBeVisible();
    await win.getByTestId("mcp-name").fill("Echo");
    await win.getByTestId("mcp-command").fill(process.execPath);
    await win.getByTestId("mcp-args").fill(ECHO_SERVER);
    await win.getByTestId("mcp-add").click();

    await expect(win.getByTestId("mcp-server-list")).toContainText("Echo");
    await expect(win.getByTestId("mcp-server-status")).toHaveText("stopped");

    // 2. Its tools. Asking starts the process, and the status says so.
    await win.getByTestId("mcp-server-tools").click();
    await expect(win.getByTestId("mcp-server-status")).toHaveText("ready", { timeout: 15_000 });
    await expect(win.getByTestId("mcp-tool-list")).toContainText("echo");
    await expect(win.getByTestId("mcp-tool-list")).toContainText("crash");

    // 3. Request a call. This is the gate: the card is up, and nothing has run.
    await win.getByTestId("mcp-call-args").fill(ARGUMENTS);
    await win
      .getByTestId("mcp-tool")
      .filter({ hasText: "echo" })
      .getByTestId("mcp-tool-call")
      .click();

    const card = win.getByTestId("mcp-approval-card");
    await expect(card).toBeVisible();
    await expect(win.getByTestId("mcp-approval-server")).toHaveText("Echo");
    await expect(win.getByTestId("mcp-approval-tool")).toHaveText("echo");
    // The arguments are shown in full, because a gate that hides what it gates is not one.
    await expect(win.getByTestId("mcp-approval-json")).toContainText("approval please");

    // Both decisions are offered...
    await expect(win.getByTestId("mcp-approval-allow")).toBeVisible();
    await expect(win.getByTestId("mcp-approval-deny")).toBeVisible();

    // ...and no result exists anywhere yet. This is the assertion the whole test is for.
    await expect(win.getByTestId("mcp-approval-result")).toHaveCount(0);
    await expect(win.getByTestId("mcp-record")).toHaveCount(0);

    // 4. Allow. The tool runs, and the result is the server's own echo of the arguments.
    await win.getByTestId("mcp-approval-allow").click();
    await expect(card).toHaveCount(0);

    const executed = win.getByTestId("mcp-record").last();
    await expect(executed.getByTestId("mcp-record-status")).toHaveText("executed");
    await expect(executed.getByTestId("mcp-approval-result")).toContainText("approval please");
    // The exact argument object made the round trip, not just its text: the echo tool
    // answers with compact JSON, and `n` is in it.
    await expect(executed.getByTestId("mcp-approval-result")).toContainText('\\"n\\":7');

    // 5. Request it again and deny. A denial is recorded, and still produces no result.
    await win
      .getByTestId("mcp-tool")
      .filter({ hasText: "echo" })
      .getByTestId("mcp-tool-call")
      .click();
    await expect(win.getByTestId("mcp-approval-card")).toBeVisible();
    await win.getByTestId("mcp-approval-deny").click();
    await expect(win.getByTestId("mcp-approval-card")).toHaveCount(0);

    const denied = win.getByTestId("mcp-record").last();
    await expect(denied.getByTestId("mcp-record-status")).toHaveText("denied");
    await expect(denied.getByTestId("mcp-approval-result")).toHaveCount(0);

    // The server is untouched by the denial: it was never asked to do anything.
    await expect(win.getByTestId("mcp-server-status")).toHaveText("ready");
  } finally {
    await app?.close();
    app = undefined;
  }
});

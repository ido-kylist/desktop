import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * The regression this file exists for: a model id is a free-form string. Sciforium
 * rejects the bare ids its own `/v1/models` advertises and demands a deployment prefix,
 * so a value outside the catalogue is not just legal — on that provider it is the only
 * thing that works.
 *
 * The old resolver replaced any uncatalogued value with the endpoint's first model, both
 * on screen and in the `chat.send` payload. These tests pin the value end to end.
 */
const PORT = 4797;
const BASE = `http://127.0.0.1:${PORT}`;
const DEPLOYMENT_ID = "/deployments/d62861ef/deepseek-ai/DeepSeek-V4.1-Flash-1017";

let mock: ChildProcess | undefined;

test.beforeAll(async () => {
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
});

/** A profile per test: a previous test's threads must not decide this one's result. */
async function makeUserData(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cleon-model-"));
}

async function launch(profile: string): Promise<{
  app: Awaited<ReturnType<typeof electron.launch>>;
  win: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>["firstWindow"]>>;
}> {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, CLEON_API_BASE: BASE, CLEON_USER_DATA: profile },
  });
  return { app, win: await app.firstWindow() };
}

test("a model id the endpoint does not list survives Save, restart and send", async () => {
  const profile = await makeUserData();
  const first = await launch(profile);

  try {
    const win = first.win;
    await win.getByTestId("open-settings").click();
    await win.getByTestId("model-input").waitFor({ timeout: 20_000 });

    // A value no /v1/models response contains.
    await win.getByLabel("Default model").fill(DEPLOYMENT_ID);
    await win.getByTestId("save-model").click();

    // The reported bug: this used to snap to a catalogued model the moment Save cleared
    // the draft.
    await expect(win.getByTestId("model-input")).toHaveValue(DEPLOYMENT_ID);

    // And it is not silently catalogued-in either: the note says it is outside the list.
    await expect(win.getByTestId("model-not-in-catalog")).toBeVisible();

    await win.getByTestId("settings-done").click();
    await expect(win.getByLabel("Model")).toHaveValue(DEPLOYMENT_ID);

    // The wire: the mock names the model it refused, so the id in the banner proves what
    // was actually sent.
    await win.getByLabel("Message").fill("hello");
    await win.getByLabel("Message").press("Enter");
    const banner = win.getByTestId("error-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText(DEPLOYMENT_ID);
  } finally {
    await first.app.close();
  }

  // Relaunch against the same profile: the value is persisted, not just held in memory.
  const second = await launch(profile);
  try {
    const win = second.win;
    await win.getByTestId("open-settings").click();
    await expect(win.getByTestId("model-input")).toHaveValue(DEPLOYMENT_ID, { timeout: 20_000 });
  } finally {
    await second.app.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("clearing the model stays cleared and refuses to send", async () => {
  const profile = await makeUserData();
  const { app, win } = await launch(profile);

  try {
    await win.getByTestId("open-settings").click();
    await win.getByTestId("model-input").waitFor({ timeout: 20_000 });
    await win.getByLabel("Default model").fill("");
    await win.getByTestId("save-model").click();
    await expect(win.getByTestId("model-input")).toHaveValue("");
    await win.getByTestId("settings-done").click();

    // Empty means empty: the composer says why it will not send, and the send button is dead.
    await expect(win.getByTestId("composer-model-missing")).toBeVisible();
    await win.getByLabel("Message").fill("this should not go anywhere");
    await expect(win.getByTestId("composer-send")).toBeDisabled();

    // Nothing was written.
    await expect(win.getByTestId("thread-list-empty")).toBeVisible();
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});

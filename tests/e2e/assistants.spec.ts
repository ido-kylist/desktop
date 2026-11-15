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
 * D6 at the UI: create an assistant, pick it, send — and the thread that comes out the
 * other side carries the assistant's id.
 *
 * The chain is deliberately end to end rather than three separate surfaces. Each link
 * is a claim that only the assembled app can make:
 *
 *  1. the library creates the row (the composer picker is fed by the same list),
 *  2. picking it takes the model out of the composer's hands,
 *  3. the answer is the fixture for the **assistant's** model, so the model main used is
 *     the assistant's and not the one the composer would otherwise have sent,
 *  4. and the persisted thread reports `assistantId` back through `chat.thread`.
 *
 * The last step is read through the app's own bridge, not the database file: what the
 * renderer can learn is the contract, and the contract is what a relaunch would use.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

/** Fast, because this test is about the wiring and not about streaming. */
const FRAME_DELAY_MS = 5;

/** The `mock/reasoning` fixture's content, and nothing like the default model's answer. */
const REASONING_ANSWER = "Four.";

let mock: ChildProcess | undefined;
let base = "";
const userDataDirs: string[] = [];

/** The slice of the preload bridge this test reads. Nothing else is exposed to the page. */
interface BridgeResult {
  ok: boolean;
  data?: unknown;
  error?: unknown;
}

/**
 * One IPC round trip, performed **inside** the page.
 *
 * The bridge object itself cannot be returned: `contextBridge` objects do not survive a
 * round trip through `evaluate` (the result is serialised, and its functions are gone).
 * So the call happens in the page and only its result comes back.
 */
function invokeInPage(win: Page, channel: string, payload: unknown): Promise<BridgeResult> {
  return win.evaluate(
    async (request: { channel: string; payload: unknown }) => {
      const scope = globalThis as unknown as {
        cleon?: { invoke(c: string, p: unknown): Promise<unknown> };
      };
      if (scope.cleon === undefined) throw new Error("the preload bridge is missing");
      return (await scope.cleon.invoke(request.channel, request.payload)) as BridgeResult;
    },
    { channel, payload },
  );
}

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
  const dir = await mkdtemp(join(tmpdir(), "cleon-d6-e2e-"));
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

test("creates an assistant, sends with it, and the thread carries its id", async () => {
  const userData = await makeUserData();
  const { app, win } = await launch(userData);

  try {
    // 1. The library: one assistant whose model is not the composer's default.
    await win.getByTestId("open-library").click();
    await win.getByTestId("tab-assistants").click();
    await win.getByTestId("assistant-name").fill("Answerer");
    await win.getByTestId("assistant-model").fill("mock/reasoning");
    await win.getByTestId("assistant-prompt").fill("Answer with a number only. Today is {{date}}.");
    await win.getByTestId("assistant-temperature").fill("0.3");
    await win.getByTestId("assistant-save").click();

    // The row is in the list, so the picker's read has something to answer with.
    await expect(win.getByTestId("assistant-list")).toContainText("Answerer");
    await win.getByTestId("library-close").click();

    // 2. The picker offers it, and picking it states the model that will be sent.
    const picker = win.getByLabel("Assistant");
    await expect(picker).toHaveValue("");
    await picker.selectOption({ label: "Answerer" });
    await expect(win.getByTestId("composer-model-locked")).toContainText("mock/reasoning");
    // The model select is gone: with an assistant picked it decides nothing.
    await expect(win.getByLabel("Model")).toHaveCount(0);

    // 3. Send. The answer is the fixture for the assistant's model, which is how the UI
    //    can tell that main used the assistant's model rather than the composer's.
    await win.getByLabel("Message").fill("how many?");
    await win.getByLabel("Message").press("Enter");

    const stop = win.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible({ timeout: 15_000 });
    await expect(win.getByText(REASONING_ANSWER)).toBeVisible({ timeout: 20_000 });
    await expect(stop).toHaveCount(0, { timeout: 20_000 });

    // 4. The persisted thread reports the assistant it was sent with, through the same
    //    channel a relaunch would use to restore it.
    const threadId = await win.evaluate(() => localStorage.getItem("cleon.thread"));
    expect(threadId).not.toBeNull();
    if (threadId === null) return;

    const bridge = (channel: string, payload: unknown): Promise<BridgeResult> =>
      invokeInPage(win, channel, payload);

    const thread = await bridge("chat.thread", { threadId });
    expect(thread.ok).toBe(true);

    const assistants = await bridge("assistants.list", { includeArchived: false });
    expect(assistants.ok).toBe(true);

    const assistantIdOf = (payload: unknown): string | null => {
      const data = payload as {
        items?: { id: string; name: string }[];
      };
      return data.items?.find((item) => item.name === "Answerer")?.id ?? null;
    };

    const createdId = assistants.data === undefined ? null : assistantIdOf(assistants.data);
    expect(createdId).not.toBeNull();

    const read = thread.data as {
      thread: { id: string; assistantId: string | null; projectId: string | null };
      messages: { role: string; text: string }[];
    };
    expect(read.thread.id).toBe(threadId);
    expect(read.thread.assistantId).toBe(createdId);
    expect(read.thread.projectId).toBeNull();
    // The turn itself is intact: the user's question and the assistant's answer.
    expect(read.messages.at(-1)?.role).toBe("assistant");
    expect(read.messages.at(-1)?.text).toBe(REASONING_ANSWER);
  } finally {
    await app.close();
  }
});

test("creates a project and files a new chat under it", async () => {
  const userData = await makeUserData();
  const { app, win } = await launch(userData);

  try {
    // The sidebar's project section: create, and it becomes the active filter.
    await win.getByTestId("project-new").fill("Research");
    await win.getByTestId("project-create").click();
    await expect(win.getByTestId("project-list")).toContainText("Research");

    // A chat started while the project is selected is filed under it.
    await win.getByLabel("Message").fill("hello from research");
    await win.getByLabel("Message").press("Enter");

    const stop = win.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible({ timeout: 15_000 });
    await expect(stop).toHaveCount(0, { timeout: 20_000 });

    const threadId = await win.evaluate(() => localStorage.getItem("cleon.thread"));
    expect(threadId).not.toBeNull();
    if (threadId === null) return;

    const bridge = (channel: string, payload: unknown): Promise<BridgeResult> =>
      invokeInPage(win, channel, payload);

    const projects = await bridge("projects.list", {});
    const thread = await bridge("chat.thread", { threadId });

    const listed = projects.data as { items: { id: string; name: string; threadCount: number }[] };
    const research = listed.items.find((item) => item.name === "Research");
    expect(research).toBeDefined();
    // The count is the sidebar's claim, and it has to be true for the filter to mean
    // anything.
    expect(research?.threadCount).toBe(1);

    const read = thread.data as { thread: { projectId: string | null } };
    expect(read.thread.projectId).toBe(research?.id ?? null);
  } finally {
    await app.close();
  }
});

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * D8 at the UI: toggle knowledge on, index a document, ask, and see the source.
 *
 * The claim this test exists to prove is the whole vertical — the parts it *cannot* prove in
 * a unit test are the ones that only appear when the real app runs: that the file the picker
 * hands over has a path main can read (`File.path` is gone; `webUtils.getPathForFile` is the
 * supported route), that retrieval happens before the turn is written, that the chip renders
 * on the live turn, and that it still renders after a relaunch because the citation list is a
 * column rather than a renderer's memory.
 *
 * The app is launched exactly as a user launches it (`args: ["."]`), against `mock/server.mjs`
 * with `CLEON_API_BASE` — the same server answers `/v1/embeddings` and the chat stream — and a
 * throwaway `CLEON_USER_DATA`, reused by the relaunch leg.
 *
 * The fixture's distinctive phrase is what makes the retrieval assertion meaningful: the mock
 * embeds token hashes, so the chunk containing "peak output of the inverter" is the one that
 * wins, and the expanded source must show exactly that sentence.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MOCK_SERVER = resolve(ROOT, "mock/server.mjs");

/** The sentence the query is written to find, and which the expanded chip must show. */
const PHRASE = "The peak output of the inverter is 5.8 kilowatts at noon";

const DOCUMENT = `# Solar array

${PHRASE}, measured on the south roof. Above 45 degrees celsius the derating
curve drops sharply and the array gives back roughly a fifth of that figure.

The battery bank holds twelve kilowatt hours.
`;

let mock: ChildProcess | undefined;
let base = "";
let app: ElectronApplication | undefined;
let userData = "";
let workDir = "";
let documentPath = "";

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

/** Sends one message, with knowledge on, and waits for the answer to finish. */
async function ask(win: Page): Promise<void> {
  // The mock's catalogue is built in, and `mock/text` is its first entry — selecting it
  // explicitly keeps the test from depending on which model the default lands on.
  await win.getByTestId("composer-model").selectOption("mock/text");
  await win.getByTestId("use-knowledge").check();
  await win.getByLabel("Message").fill("what is the peak output of the inverter?");
  // `exact` because the diagnostics strip also has a "Send ping" button.
  await win.getByRole("button", { name: "Send", exact: true }).click();

  // The answer is the mock's fixed text, which is proof the turn completed rather than
  // hung; the citation assertions below do not depend on it.
  await expect(win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mock = spawn(process.execPath, [MOCK_SERVER], {
    env: { ...process.env, PORT: String(port), FRAME_DELAY_MS: "5" },
    stdio: "ignore",
  });
  await waitForHealth();

  workDir = await mkdtemp(join(tmpdir(), "cleon-d8-e2e-"));
  userData = join(workDir, "userdata");
  await mkdir(userData, { recursive: true });
  documentPath = join(workDir, "solar.md");
  await writeFile(documentPath, DOCUMENT);
});

test.afterAll(async () => {
  mock?.kill();
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

test("a knowledge-backed answer shows a citation chip that expands to its source", async () => {
  const launched = await launch(userData);
  app = launched.app;
  let win = launched.win;

  try {
    // 1. Index the document through the panel, with the file the picker hands over.
    await win.getByTestId("open-knowledge").click();
    await expect(win.getByTestId("kb-panel")).toBeVisible();
    await win.getByTestId("kb-file-input").setInputFiles(documentPath);

    await expect(win.getByTestId("kb-document")).toHaveCount(1, { timeout: 20_000 });
    await expect(win.getByTestId("kb-document")).toContainText("solar.md");
    // The chunk count is the number of vectors search will scan, and it is a real count.
    const chunks = win.getByTestId("kb-document-chunks");
    await expect(chunks).not.toHaveText(/^0 chunks/);
    await expect(chunks).toHaveAttribute("data-chunks", /^[1-9][0-9]*$/);

    // 2. The search preview ranks the document's chunk for the question asked below.
    await win.getByTestId("kb-search-input").fill("peak output of the inverter");
    await win.getByTestId("kb-search-run").click();
    await expect(win.getByTestId("kb-search-hit").first()).toContainText("solar.md");
    // A score is shown, because a ranking whose numbers are hidden cannot be debugged.
    await expect(win.getByTestId("kb-search-score").first()).toHaveText(/^-?\d+\.\d{3}$/);

    await win.getByTestId("kb-close").click();
    await expect(win.getByTestId("kb-panel")).toHaveCount(0);

    // 3. Ask with knowledge on. The chip is drawn from the send response, so it is on screen
    //    while the answer streams rather than after a reload.
    await ask(win);
    const chip = win.getByTestId("citation-chip").first();
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("solar.md");

    // 4. Expanding the chip reads the stored chunk back and shows the sentence it came from.
    await chip.click();
    const source = win.getByTestId("citation-source");
    await expect(source).toBeVisible();
    await expect(source).toContainText(PHRASE);

    // 5. Relaunch with the same user data. The thread is restored, and so are the chips —
    //    which is the whole reason the citation list is a column and not renderer state.
    await app?.close();
    app = undefined;
    const relaunched = await launch(userData);
    app = relaunched.app;
    win = relaunched.win;

    await expect(win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });
    expect(win.getByTestId("use-knowledge")).not.toBeChecked();

    const restored = win.getByTestId("citation-chip").first();
    await expect(restored).toBeVisible();
    await expect(restored).toContainText("solar.md");

    // And it still expands: the chunk is read from the database, not from the turn's memory.
    await restored.click();
    await expect(win.getByTestId("citation-source")).toContainText(PHRASE);
  } finally {
    await app?.close();
    app = undefined;
  }
});

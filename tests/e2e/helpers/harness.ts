import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
} from "@playwright/test";

/**
 * The shared setup for the D9 specs (accessibility, keyboard, states).
 *
 * `chat.spec.ts`, `history.spec.ts` and the rest each carry their own copy of this
 * boilerplate — that predates this file and is not worth churning. What made a helper
 * necessary here is that the three D9 specs each need the same four things (a mock on a
 * free port, a throwaway profile, a launch that waits for the title, and a turn that has
 * actually finished) and the accessibility spec additionally needs axe installed without
 * weakening the renderer's CSP.
 *
 * **axe and the CSP.** The renderer ships `script-src 'self'`, so an inline `<script>`
 * injected by `addScriptTag` is refused by Chromium — verified, not assumed. Rather than
 * loosen the policy for a test (which would weaken invariant 1 for the code that ships),
 * axe is installed with `addInitScript`, which Playwright delivers through the debugger
 * protocol before the document's own scripts run and is therefore not subject to the
 * page's CSP. It requires one reload, which is safe here: the app is a local-first SPA
 * that restores the remembered thread from storage, so the reload lands on the same
 * screen.
 */

/** Three levels up from `tests/e2e/helpers`: the repo root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Slow enough that a generation is observable; the text fixture is 7 frames. */
export const FRAME_DELAY_MS = 60;

export interface MockServer {
  readonly base: string;
  stop: () => void;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
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

/** A port nothing is listening on, for the provider-unreachable state. */
export async function closedPort(): Promise<number> {
  return freePort();
}

export interface Blackhole {
  readonly base: string;
  stop: () => void;
}

/**
 * A server that accepts a connection and never answers.
 *
 * This is the only way to hold a request open long enough to see a *loading* state from
 * the outside: `models.list` has a five-second deadline, and a real provider answers in
 * milliseconds, so the "Loading models…" line is otherwise a frame nobody can observe.
 * It is not a mock — it says nothing at all, which is exactly the point.
 */
export async function startBlackhole(): Promise<Blackhole> {
  const port = await freePort();
  // The sockets are tracked rather than ignored: `close()` waits for open connections, and
  // these connections exist precisely to stay open.
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    // Deliberately empty: the request stays open until the client's own deadline fires.
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });

  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
    },
  };
}

async function waitForHealth(base: string, timeoutMs = 10_000): Promise<void> {
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

export async function startMock(): Promise<MockServer> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["mock/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), FRAME_DELAY_MS: String(FRAME_DELAY_MS) },
    stdio: "ignore",
  });
  await waitForHealth(base);
  return { base, stop: () => child.kill() };
}

const userDataDirs: string[] = [];

export async function makeUserData(prefix = "cleon-d9-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  userDataDirs.push(dir);
  return dir;
}

export async function cleanupUserData(): Promise<void> {
  await Promise.all(userDataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export interface LaunchOptions {
  /** `null` removes the override entirely, so the Settings screen's saved URL is used. */
  baseUrl?: string | null;
}

/** `process.env` may hold `undefined`; Playwright's `env` wants strings only. */
function appEnv(userData: string, options: LaunchOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.CLEON_USER_DATA = userData;
  if (options.baseUrl === null) delete env.CLEON_API_BASE;
  else if (options.baseUrl !== undefined) env.CLEON_API_BASE = options.baseUrl;
  return env;
}

export interface Launched {
  app: ElectronApplication;
  win: Page;
}

export async function launch(userData: string, options: LaunchOptions = {}): Promise<Launched> {
  const app = await electron.launch({ args: ["."], env: appEnv(userData, options) });
  const win = await app.firstWindow();
  await expect(win).toHaveTitle("Cleon");
  return { app, win };
}

/** Sends a message and waits for the whole turn to finish (Stop appears, then goes). */
export async function sendAndWait(win: Page, text: string): Promise<void> {
  await win.getByLabel("Message").fill(text);
  await win.getByLabel("Message").press("Enter");

  const stop = win.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await expect(stop).toHaveCount(0, { timeout: 20_000 });
}

/* ------------------------------------------------------------------- axe */

/** One element an axe rule failed on: where it is, what it is, and why. */
export interface AxeNode {
  target: string[];
  html: string;
  failureSummary: string | null;
}

export interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  helpUrl: string;
  nodes: AxeNode[];
}

interface AxeGlobal {
  run: (
    context: Document,
    options: { runOnly: { type: "tag"; values: string[] } },
  ) => Promise<{ violations: AxeViolation[] }>;
}

interface AxeWindow {
  axe?: AxeGlobal;
}

/**
 * Installs axe-core, then reloads once so it is present from the first paint.
 *
 * The reload is the point: a panel that is already open would not have had axe during
 * its first render, and a live region added after an answer streams would not be observed.
 * Everything the specs assert happens after this returns.
 */
export async function installAxe(win: Page): Promise<void> {
  const source = await readFile(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
  await win.addInitScript({ content: source });
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win).toHaveTitle("Cleon");
  await expect
    .poll(async () => win.evaluate(() => (globalThis as unknown as AxeWindow).axe !== undefined), {
      timeout: 10_000,
    })
    .toBe(true);
}

/**
 * Runs axe over the current document with the WCAG 2.0/2.1 A+AA rule sets plus
 * axe's own best-practice rules.
 *
 * The best-practice set is included deliberately: it is where `region`, `heading-order`
 * and the landmark rules live, and those are the findings this audit is for. It is not
 * part of the conformance claim, so a failure there is still a defect worth fixing —
 * which is why it is in the same run rather than a second, ignorable one.
 */
export async function runAxe(win: Page): Promise<AxeViolation[]> {
  return win.evaluate(async () => {
    const axe = (globalThis as unknown as AxeWindow).axe;
    if (axe === undefined) throw new Error("axe-core is not installed on this page");
    const results = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
      },
    });
    return results.violations;
  });
}

const SEVERE = new Set(["serious", "critical"]);

export function severe(violations: readonly AxeViolation[]): AxeViolation[] {
  return violations.filter(
    (violation) => violation.impact !== null && SEVERE.has(violation.impact),
  );
}

/**
 * A violation list as text, because Playwright truncates an object diff and the thing
 * that matters is which selector failed and why.
 */
export function describeViolations(violations: readonly AxeViolation[]): string {
  if (violations.length === 0) return "(none)";
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => `    ${node.target.join(" ")}\n      ${node.failureSummary ?? ""}`)
        .join("\n");
      return `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n${nodes}`;
    })
    .join("\n");
}

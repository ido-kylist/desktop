import { join } from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import {
  cleanupUserData,
  closedPort,
  launch,
  type MockServer,
  makeUserData,
  sendAndWait,
  startBlackhole,
  startMock,
} from "./helpers/harness";

/**
 * The state matrix, executed. `docs/STATES.md` is the written form; this file is the part
 * of it that can be driven from outside the app on a real build.
 *
 * The rule being enforced is AGENTS.md's: **a failure must never render as an empty
 * list.** Every panel has four reads (loading, empty, error, offline) and a user cannot
 * act on a state they cannot see. The states that cannot be reached black-box are named in
 * `STATES.md` with the reason they are not here, rather than left implied.
 *
 * Two of these are new in D9 and would have failed before it:
 *
 *  - the chat panel's provider-unreachable banner (it used to be one red banner with a
 *    different code inside it);
 *  - the empty-thread state (the transcript used to render nothing at all).
 */

let mock: MockServer;

test.beforeAll(async () => {
  mock = await startMock();
});

test.afterAll(async () => {
  mock.stop();
  await cleanupUserData();
});

test("chat: a provider that cannot be reached is its own state", async () => {
  const userData = await makeUserData("cleon-states-offline-");
  const port = await closedPort();
  const { app, win } = await launch(userData, { baseUrl: `http://127.0.0.1:${port}` });

  try {
    await win.getByLabel("Message").fill("does this reach anyone");
    await win.getByLabel("Message").press("Enter");

    const banner = win.getByTestId("error-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });

    // The state is marked, not implied: the banner says offline and the note names it.
    await expect(banner).toHaveAttribute("data-state", "offline");
    await expect(banner).toContainText("UPSTREAM_ERROR");
    await expect(win.getByTestId("error-banner-offline")).toContainText("Provider unreachable");

    // Nothing was lost: the user's turn is on screen and persisted, and Retry is offered
    // because a dropped connection — unlike a budget — is the thing that comes back.
    await expect(win.getByText("does this reach anyone", { exact: true })).toBeVisible();
    await expect(win.getByRole("button", { name: "Retry" })).toBeEnabled();

    // The composer's catalogue says the same thing rather than showing an empty select.
    await expect(win.getByTestId("composer-model-note")).toContainText("did not answer", {
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});

test("chat: an empty thread says so instead of rendering nothing", async () => {
  const userData = await makeUserData("cleon-states-empty-");
  const first = await launch(userData, { baseUrl: mock.base });

  try {
    await sendAndWait(first.win, "a turn that will be deleted behind the app's back");
    await expect(first.win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });
  } finally {
    await first.app.close();
  }

  // Soft-delete every message, which is what a thread whose turns were all deleted looks
  // like: the thread row survives, its transcript is empty. Reaching this through the UI
  // is not possible yet (there is no per-message delete), so the database is the honest
  // way to build the state — and it is the same predicate `chat.thread` filters on.
  const db = new Database(join(userData, "cleon.db"));
  try {
    db.pragma("journal_mode = WAL");
    db.prepare("UPDATE messages SET deleted_at = ?").run(new Date().toISOString());
  } finally {
    db.close();
  }

  const second = await launch(userData, { baseUrl: mock.base });
  try {
    // The remembered thread is restored (G1), and it is empty rather than blank.
    await expect(second.win.getByTestId("thread-empty")).toBeVisible({ timeout: 20_000 });
    await expect(second.win.getByTestId("thread-empty")).toContainText("No messages");
  } finally {
    await second.app.close();
  }
});

test("settings: an unreachable provider is a distinct, visible state", async () => {
  const userData = await makeUserData("cleon-states-settings-");
  const port = await closedPort();
  const { app, win } = await launch(userData, { baseUrl: `http://127.0.0.1:${port}` });

  try {
    await win.getByTestId("open-settings").click();
    await expect(win.getByTestId("base-url")).toBeVisible();

    const offline = win.getByTestId("settings-offline");
    await expect(offline).toBeVisible({ timeout: 15_000 });
    await expect(offline).toHaveAttribute("data-state", "offline");
    await expect(offline).toContainText("Provider unreachable");
    await expect(offline).toContainText("built-in fallback");

    // The catalogue line says where the list came from, and the form still works: an
    // unreachable provider must not take the screen that fixes it down with it.
    await expect(win.getByTestId("model-note")).toContainText("Source: fallback");
    await expect(win.getByTestId("base-url")).toBeEditable();
  } finally {
    await app.close();
  }
});

test("settings: a provider that has not answered yet shows loading, not an empty list", async () => {
  const userData = await makeUserData("cleon-states-loading-");
  const blackhole = await startBlackhole();
  const { app, win } = await launch(userData, { baseUrl: blackhole.base });

  try {
    await win.getByTestId("open-settings").click();
    await expect(win.getByTestId("base-url")).toBeVisible();

    // The request is open (the blackhole never answers), so this is the loading state and
    // not a race: the select is disabled and the note says what is happening.
    await expect(win.getByTestId("model-note")).toContainText("Loading models…");
    // Free text, so the field works before the catalogue answers; the note is what says
    // the list itself has not arrived. A disabled field would block a valid typed id.
    await expect(win.getByTestId("model-input")).toBeEnabled();

    // The composer says the same thing, from the same query.
    await win.getByTestId("settings-done").click();
    await expect(win.getByTestId("composer-model-note")).toContainText("Loading models…");
  } finally {
    await app.close();
    blackhole.stop();
  }
});

test("knowledge: a search that cannot reach the embedding provider says offline", async () => {
  const userData = await makeUserData("cleon-states-kb-");
  const port = await closedPort();
  const { app, win } = await launch(userData, { baseUrl: `http://127.0.0.1:${port}` });

  try {
    await win.getByTestId("open-knowledge").click();
    await expect(win.getByTestId("kb-list-empty")).toBeVisible({ timeout: 15_000 });

    await win.getByTestId("kb-search-input").fill("anything at all");
    await win.getByTestId("kb-search-run").click();

    const error = win.getByTestId("kb-error");
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toHaveAttribute("data-state", "offline");
    await expect(error).toContainText("Provider unreachable");
    await expect(error).toContainText("UPSTREAM_ERROR");

    // And it is not the search-empty state: an empty corpus is a different sentence.
    await expect(win.getByTestId("kb-search-empty")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

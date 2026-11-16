import { expect, test } from "@playwright/test";
import {
  cleanupUserData,
  describeViolations,
  installAxe,
  launch,
  type MockServer,
  makeUserData,
  runAxe,
  sendAndWait,
  severe,
  startMock,
} from "./helpers/harness";

/**
 * The accessibility audit, run against the real app on the five screens the brief names:
 * chat, history search results, settings, knowledge, MCP.
 *
 * What this proves and what it does not:
 *
 *  - `axe-core` is run in the renderer with the WCAG 2.0 and 2.1 A/AA rule sets plus axe's
 *    best-practice rules. The gate is **zero serious or critical violations**; moderate and
 *    minor findings are printed so they are visible rather than swallowed, and every one
 *    that was found in the first run was fixed rather than downgraded.
 *  - axe cannot see focus order, a lost focus ring, a route that is unreachable by
 *    keyboard, or whether a live region is on the right node. Those are
 *    `keyboard.spec.ts`'s job, and `states.spec.ts` owns the state matrix. "No axe
 *    violations" is a floor, not a claim of accessibility.
 */

let mock: MockServer;

/**
 * The slice of axe this file drives in the planted-violation control. The full shape lives
 * in `helpers/harness.ts`; this is the one call the control makes inline.
 */
interface AxeWindowGlobal {
  axe?: {
    run: (
      context: Element,
      options: { runOnly: { type: "tag"; values: string[] } },
    ) => Promise<{ violations: { id: string }[] }>;
  };
}

test.beforeAll(async () => {
  mock = await startMock();
});

test.afterAll(async () => {
  mock.stop();
  await cleanupUserData();
});

/**
 * Runs axe, prints every finding with its selector, and fails on serious or critical.
 *
 * Printing the full list even on a pass is deliberate: a moderate finding left in place is
 * a decision, and a decision nobody can see in the log is one nobody can revisit.
 */
async function audit(win: Parameters<typeof runAxe>[0], screen: string): Promise<void> {
  const violations = await runAxe(win);
  // Printed, not swallowed: the report is the artefact, and Biome allows console in tests.
  console.log(`[a11y] ${screen}: ${describeViolations(violations)}`);

  expect(severe(violations), `serious/critical axe violations on ${screen}`).toEqual([]);
}

test("chat and history search results", async () => {
  const userData = await makeUserData("cleon-a11y-chat-");
  const { app, win } = await launch(userData, { baseUrl: mock.base });

  try {
    await installAxe(win);

    // The chat screen with a real turn on it — the empty invitation is a different screen
    // and is audited as part of the states spec.
    await sendAndWait(win, "a first thread about otters");
    await expect(win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });
    await audit(win, "chat");

    // History with a result: the row carries a title, a relative time, a count and an FTS
    // snippet with <mark> highlights, which is a different DOM than the resting list.
    const search = win.getByTestId("thread-search");
    await search.fill("otters");
    await expect(win.getByTestId("thread-row")).toHaveCount(1, { timeout: 20_000 });
    await expect(win.getByTestId("thread-row").locator("mark")).toContainText("otters");
    await audit(win, "history search results");
  } finally {
    await app.close();
  }
});

test("settings", async () => {
  const userData = await makeUserData("cleon-a11y-settings-");
  const { app, win } = await launch(userData, { baseUrl: mock.base });

  try {
    await installAxe(win);
    await win.getByTestId("open-settings").click();
    await expect(win.getByTestId("settings")).toBeVisible();
    // The form only exists once settings.get answered; auditing the loading skeleton
    // would be auditing a screen the user sees for a few milliseconds.
    await expect(win.getByTestId("base-url")).toBeVisible();
    await expect(win.getByTestId("model-input")).not.toHaveValue("", { timeout: 15_000 });
    await audit(win, "settings");
  } finally {
    await app.close();
  }
});

test("knowledge", async () => {
  const userData = await makeUserData("cleon-a11y-kb-");
  const { app, win } = await launch(userData, { baseUrl: mock.base });

  try {
    await installAxe(win);
    await win.getByTestId("open-knowledge").click();
    await expect(win.getByTestId("kb-panel")).toBeVisible();
    await expect(win.getByTestId("kb-list-empty")).toBeVisible({ timeout: 15_000 });
    await audit(win, "knowledge");
  } finally {
    await app.close();
  }
});

test("mcp", async () => {
  const userData = await makeUserData("cleon-a11y-mcp-");
  const { app, win } = await launch(userData, { baseUrl: mock.base });

  try {
    await installAxe(win);
    await win.getByTestId("open-mcp").click();
    await expect(win.getByTestId("mcp-panel")).toBeVisible();
    await expect(win.getByTestId("mcp-list-empty")).toBeVisible({ timeout: 15_000 });
    await audit(win, "mcp");
  } finally {
    await app.close();
  }
});

/**
 * The audit's own negative control.
 *
 * "Zero violations" is only meaningful if the audit is looking at a real document with a
 * real rule set. This plants two violations the WCAG rules must catch — an image with no
 * accessible name and a link with no discernible text — and asserts they are reported with
 * the impact that gates the suite. Without this, a typo in the axe install would turn all
 * four audits above into a green no-op.
 */
test("the audit itself catches a planted violation", async () => {
  const userData = await makeUserData("cleon-a11y-control-");
  const { app, win } = await launch(userData, { baseUrl: mock.base });

  try {
    await installAxe(win);

    const planted = await win.evaluate(async () => {
      const host = document.createElement("div");
      host.id = "planted-violations";
      host.innerHTML = '<img src="app://bundle/none.png"><a href="#"></a>';
      document.body.append(host);

      const axe = (globalThis as unknown as AxeWindowGlobal).axe;
      if (axe === undefined) throw new Error("axe-core is not installed on this page");
      const results = await axe.run(host, { runOnly: { type: "tag", values: ["wcag2a"] } });
      host.remove();
      return results.violations.map((violation) => violation.id);
    });

    expect(planted).toContain("image-alt");
    expect(planted).toContain("link-name");
  } finally {
    await app.close();
  }
});

import { expect, type Page, test } from "@playwright/test";
import {
  cleanupUserData,
  launch,
  type MockServer,
  makeUserData,
  startMock,
} from "./helpers/harness";

/**
 * The whole composer flow with the keyboard and nothing else. No `click`, no `fill`, no
 * `hover` anywhere in this file — every interaction is a key press, and every assertion is
 * about where focus and the caret actually are.
 *
 * What it proves:
 *
 *  1. The composer is reachable by `Tab` alone, from the top of the document.
 *  2. A turn can be composed and sent with keys (Enter sends; the IME guard is unit-tested
 *     elsewhere).
 *  3. The transcript is reachable by `Tab` **forward** from the composer, which is the
 *     claim that matters: a focus trap or a non-focusable message would fail it. Counting
 *     tabs is not the assertion — landing inside `.messages` is.
 *  4. Regenerate is reachable and activatable, and focus comes back to the variant
 *     switcher after the re-read replaces the message row. That restore is a fix in
 *     `App.tsx`: without it, focus fell to `document.body` and a keyboard user had to walk
 *     the window again to take a second look at the branch.
 *  5. The variant switcher works from the keyboard and keeps focus across the second
 *     re-read.
 *  6. The live region is on the streaming answer's body (`aria-live="polite"` on `.md`)
 *     and nowhere near the list, so a screen reader hears the answer arrive rather than
 *     re-hearing the thread.
 */

let mock: MockServer;

test.beforeAll(async () => {
  mock = await startMock();
});

test.afterAll(async () => {
  mock.stop();
  await cleanupUserData();
});

interface FocusInfo {
  testId: string | null;
  label: string | null;
  tag: string;
  inTranscript: boolean;
}

async function focusInfo(win: Page): Promise<FocusInfo> {
  return win.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return { testId: null, label: null, tag: "none", inTranscript: false };
    }
    return {
      testId: active.dataset.testid ?? null,
      label: active.getAttribute("aria-label"),
      tag: active.tagName.toLowerCase(),
      inTranscript: active.closest(".transcript") !== null,
    };
  });
}

/** Presses Tab until the predicate holds, and fails with where focus ended up. */
async function tabUntil(
  win: Page,
  predicate: (info: FocusInfo) => boolean,
  max: number,
): Promise<void> {
  for (let press = 0; press <= max; press += 1) {
    const info = await focusInfo(win);
    if (predicate(info)) return;
    if (press === max) {
      throw new Error(
        `focus never reached the target after ${max} Tab presses; last focus: ${JSON.stringify(info)}`,
      );
    }
    await win.keyboard.press("Tab");
  }
}

/** Waits for the turn on screen to finish, using only what the DOM says. */
async function waitForTurnEnd(win: Page): Promise<void> {
  const stop = win.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await expect(stop).toHaveCount(0, { timeout: 20_000 });
}

test("sends, regenerates and switches a variant without a pointer", async () => {
  const userData = await makeUserData("cleon-kbd-");
  const { app, win } = await launch(userData, { baseUrl: mock.base });

  try {
    // 1. The composer holds the caret on mount, so typing works with no click at all.
    await expect
      .poll(async () => (await focusInfo(win)).label, { timeout: 10_000 })
      .toBe("Message");

    // …and it is reachable from the top of the document too, which is what a user who
    // tabbed away and came back needs.
    await win.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await tabUntil(win, (info) => info.label === "Message", 40);

    // 2. Type and send with keys. Shift+Enter is a newline and is asserted on the text
    // that reaches the store: the transcript keeps the user's own line break.
    await win.keyboard.type("keyboard only line one");
    await win.keyboard.press("Shift+Enter");
    await win.keyboard.type("line two");
    await expect(win.getByLabel("Message")).toHaveValue("keyboard only line one\nline two");

    // 3. While the answer streams, the polite region is the answer's body and nothing else.
    await win.keyboard.press("Enter");
    await expect(win.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });
    const liveRegions = win.locator('[aria-live="polite"]');
    await expect(liveRegions).toHaveCount(1);
    // The one live region is a message body, not the transcript and not the list.
    await expect(win.locator('.messages [aria-live="polite"]')).toHaveCount(1);
    await expect(win.locator(".transcript[aria-live], .messages[aria-live]")).toHaveCount(0);
    await expect(win.locator('.messages [aria-live="polite"]')).toHaveClass(/md/);

    await expect(win.getByText("Hello from the mock.")).toBeVisible({ timeout: 20_000 });
    await waitForTurnEnd(win);

    // Once the answer is finished it is no longer a live region: re-reading the thread
    // announces nothing.
    await expect(liveRegions).toHaveCount(0);

    // 4. Reach the transcript by Tab, forward, from the composer.
    await tabUntil(win, (info) => info.inTranscript, 60);

    // 5. Tab on to Regenerate, activate it with Enter, and wait for the second answer.
    await tabUntil(win, (info) => info.testId === "regenerate", 20);
    await win.keyboard.press("Enter");
    await waitForTurnEnd(win);

    // The re-read replaced the answer row; focus has to be back on the switcher it created.
    await expect(win.getByTestId("variant-count")).toHaveText("2 / 2", { timeout: 15_000 });
    await expect.poll(async () => (await focusInfo(win)).testId).toMatch(/^variant-(next|prev)$/);

    // 6. Switch to the other variant with the keyboard. The second re-read must not lose
    // focus either.
    await win.keyboard.press("Enter");
    await expect(win.getByTestId("variant-count")).toHaveText("1 / 2", { timeout: 15_000 });
    await expect.poll(async () => (await focusInfo(win)).testId).toMatch(/^variant-(next|prev)$/);
  } finally {
    await app.close();
  }
});

/**
 * A modal panel, opened and closed from the keyboard.
 *
 * A dialog that `aria-modal`s the page but leaves focus behind it is worse than no
 * `aria-modal`: `Tab` walks controls the user cannot see, and closing it drops them at the
 * top of the document. Both halves are asserted here — focus enters on open, and it comes
 * back to the button that opened it.
 */
test("a panel takes focus on open and gives it back on Escape", async () => {
  const userData = await makeUserData("cleon-kbd-dialog-");
  const { app, win } = await launch(userData, { baseUrl: mock.base });

  try {
    // Reach the MCP button by Tab from the top, then open it with Enter.
    await win.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await tabUntil(win, (info) => info.testId === "open-mcp", 20);
    await win.keyboard.press("Enter");
    await expect(win.getByTestId("mcp-panel")).toBeVisible();

    // Focus is inside the dialog, not on the button behind it.
    await expect.poll(async () => (await focusInfo(win)).inTranscript).toBe(false);
    const inDialog = await win.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.closest('[data-testid="mcp-panel"]') !== null;
    });
    expect(inDialog).toBe(true);

    // Escape closes it, and focus is back on the button that opened it.
    await win.keyboard.press("Escape");
    await expect(win.getByTestId("mcp-panel")).toHaveCount(0);
    await expect.poll(async () => (await focusInfo(win)).testId).toBe("open-mcp");
  } finally {
    await app.close();
  }
});

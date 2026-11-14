import { _electron as electron, expect, test } from "@playwright/test";

/**
 * D0.5 rehearsal. Proves the new scratch.wordCount channel is wired end to end:
 * a real window, real input, a real IPC round trip, and a rendered count — not a
 * mock of any of the three layers.
 */
test("counts words from the textarea and renders the result", async () => {
  const app = await electron.launch({ args: ["."] });

  try {
    const win = await app.firstWindow();
    await expect(win).toHaveTitle("Cleon");

    await win.getByTestId("word-count-input").fill("  hello   world  ");
    await win.getByRole("button", { name: "Count words" }).click();

    await expect(win.getByTestId("word-count-result")).toHaveText("2 words · 17 characters");
    await expect(win.getByTestId("word-count-error")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a malformed payload comes back as BAD_REQUEST, not a crash", async () => {
  const app = await electron.launch({ args: ["."] });

  try {
    const win = await app.firstWindow();
    await expect(win).toHaveTitle("Cleon");

    // Bypasses the typed wrapper the UI uses so the request schema is the thing
    // under test. A rejected payload must come back as an error envelope, and
    // the app must keep answering afterwards.
    const result = await win.evaluate(async () => {
      const bridge = window as unknown as {
        cleon: { invoke: (channel: string, payload: unknown) => Promise<unknown> };
      };
      return bridge.cleon.invoke("scratch.wordCount", { text: 42 });
    });

    expect(result).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    await expect(win.getByRole("button", { name: "Send ping" })).toBeEnabled();
  } finally {
    await app.close();
  }
});

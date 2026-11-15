import { describe, expect, it } from "vitest";
import { parseDeepLink, parseDeepLinkFromArgv } from "../../src/main/native/deeplinks.js";

/**
 * `cleon://deep links`, parsed.
 *
 * A deep link is the one input that reaches this app from outside it, produced by
 * whatever holds the OS scheme registration: a browser, a mail client, another app's
 * clipboard. It has to be hostile-input-safe, so the assertions below are mostly about
 * refusals. Everything here is a pure function of a string — no Electron, no window,
 * no app instance — which is exactly why the parser was written to be importable from
 * a plain Node process.
 */

const THREAD_ID = "3f2504e1-2a3c-4f1b-9d8e-7c6b5a40321f";
const OTHER_THREAD_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";

describe("parseDeepLink", () => {
  it("accepts the one link this build answers to", () => {
    expect(parseDeepLink(`cleon://thread/${THREAD_ID}`)).toEqual({
      kind: "thread",
      threadId: THREAD_ID,
    });
  });

  it("accepts a trailing slash", () => {
    // Hand-typed and pasted links collect one: `cleon://thread/<uuid>/` is the same
    // request, and refusing it would be pedantry the user pays for.
    expect(parseDeepLink(`cleon://thread/${THREAD_ID}/`)).toEqual({
      kind: "thread",
      threadId: THREAD_ID,
    });
  });

  it("accepts an upper-case uuid and lower-cases it", () => {
    // Links arrive capitalised. Thread ids are stored lower-case, so passing the
    // casing through would turn a valid link into "thread not found".
    expect(parseDeepLink(`cleon://thread/${THREAD_ID.toUpperCase()}`)).toEqual({
      kind: "thread",
      threadId: THREAD_ID,
    });
  });

  it("keeps two different threads apart", () => {
    expect(parseDeepLink(`cleon://thread/${OTHER_THREAD_ID}`)).toEqual({
      kind: "thread",
      threadId: OTHER_THREAD_ID,
    });
  });

  it("refuses an id that is not a uuid", () => {
    // The important refusal: this is what keeps a bogus id from being handed to the
    // renderer, focused, and turned into a failed lookup.
    expect(parseDeepLink("cleon://thread/not-a-uuid")).toBeNull();
    expect(parseDeepLink("cleon://thread/12345")).toBeNull();
    // The right shape with a character which is not hex.
    expect(parseDeepLink("cleon://thread/3f2504e1-2a3c-4f1b-9d8e-7c6b5a40321z")).toBeNull();
  });

  it("refuses any other scheme", () => {
    expect(parseDeepLink(`https://thread/${THREAD_ID}`)).toBeNull();
    expect(parseDeepLink(`cleonx://thread/${THREAD_ID}`)).toBeNull();
    expect(parseDeepLink(`file://thread/${THREAD_ID}`)).toBeNull();
  });

  it("refuses any other host", () => {
    expect(parseDeepLink(`cleon://settings/${THREAD_ID}`)).toBeNull();
    expect(parseDeepLink(`cleon://threads/${THREAD_ID}`)).toBeNull();
  });

  it("refuses a link with no id, or with more path than an id", () => {
    expect(parseDeepLink("cleon://thread")).toBeNull();
    expect(parseDeepLink("cleon://thread/")).toBeNull();
    expect(parseDeepLink(`cleon://thread/${THREAD_ID}/${OTHER_THREAD_ID}`)).toBeNull();
    expect(parseDeepLink(`cleon://thread/a/${THREAD_ID}`)).toBeNull();
  });

  it("refuses things that are not URLs at all", () => {
    // argv[0] is the binary path, and flags are flags. Neither may be logged as a
    // malformed link.
    expect(parseDeepLink("")).toBeNull();
    expect(parseDeepLink("Electron")).toBeNull();
    expect(parseDeepLink("/Applications/Cleon.app/Contents/MacOS/Cleon")).toBeNull();
  });
});

describe("parseDeepLinkFromArgv", () => {
  it("finds the link in the argv a second launch is handed", () => {
    // The Windows/Linux arrival path: the OS appends the URL to the argv of the
    // process that already holds the single-instance lock.
    expect(parseDeepLinkFromArgv(["Electron", "app", `cleon://thread/${THREAD_ID}`])).toEqual({
      kind: "thread",
      threadId: THREAD_ID,
    });
  });

  it("finds the link behind a binary path and flags", () => {
    expect(
      parseDeepLinkFromArgv([
        "/Applications/Cleon.app/Contents/MacOS/Cleon",
        "--from-os",
        `cleon://thread/${THREAD_ID}`,
      ]),
    ).toEqual({ kind: "thread", threadId: THREAD_ID });
  });

  it("is null when the second launch carried no link", () => {
    // A plain second launch: the app should come forward, and nothing should be
    // delivered. `null` is that difference.
    expect(parseDeepLinkFromArgv(["Electron", "app"])).toBeNull();
    expect(parseDeepLinkFromArgv([])).toBeNull();
  });

  it("ignores an invalid link rather than returning a half-parsed one", () => {
    expect(parseDeepLinkFromArgv(["Electron", "cleon://thread/not-a-uuid"])).toBeNull();
  });
});

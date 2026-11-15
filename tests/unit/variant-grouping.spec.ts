import { describe, expect, it } from "vitest";
import {
  buildThreadView,
  type VariantGroup,
  type VariantMessage,
} from "../../src/renderer/src/lib/variants.js";

/**
 * D3's tree maths: a flat list plus `activeLeafId` becomes one ordered path and a
 * sibling set per branch point.
 *
 * The cases that decide the UI: a linear thread (nothing to switch), a three-way
 * regeneration (the "2 / 3" affordance), a branch that a later turn continues from,
 * and a server that sends only the active path with the sibling ids declared on the
 * message instead.
 */

interface Msg extends VariantMessage {
  text: string;
}

function message(id: string, parentId: string | null, text = id, variants?: string[]): Msg {
  return variants === undefined ? { id, parentId, text } : { id, parentId, text, variants };
}

function texts(path: readonly Msg[]): string[] {
  return path.map((entry) => entry.text);
}

function groupOf(groups: Record<string, VariantGroup>, id: string): VariantGroup | undefined {
  return groups[id];
}

describe("buildThreadView: a linear thread", () => {
  const linear: Msg[] = [
    message("u1", null, "hi"),
    message("a1", "u1", "Hello."),
    message("u2", "a1", "and again"),
    message("a2", "u2", "Hello again."),
  ];

  it("returns every message in order and no sibling sets", () => {
    const view = buildThreadView(linear, null);
    expect(texts(view.path)).toEqual(["hi", "Hello.", "and again", "Hello again."]);
    expect(view.groups).toEqual({});
  });

  it("treats a missing parent as a root, which is how the oldest rows are stored", () => {
    const roots: Msg[] = [
      { id: "u1", text: "hi" },
      { id: "a1", parentId: "u1", text: "Hello." },
    ];
    expect(texts(buildThreadView(roots, undefined).path)).toEqual(["hi", "Hello."]);
  });

  it("returns an empty view for an empty list", () => {
    expect(buildThreadView([], null)).toEqual({ path: [], groups: {} });
  });
});

describe("buildThreadView: three variants under one parent", () => {
  const branched: Msg[] = [
    message("u1", null, "hi"),
    message("a1", "u1", "first answer"),
    message("a2", "u1", "second answer"),
    message("a3", "u1", "third answer"),
  ];

  it("keeps only the active leaf's path on screen", () => {
    const view = buildThreadView(branched, "a2");
    expect(texts(view.path)).toEqual(["hi", "second answer"]);
  });

  it("counts the siblings as 2 / 3 and aims the arrows at their ids", () => {
    const view = buildThreadView(branched, "a2");
    expect(groupOf(view.groups, "a2")).toEqual({ ids: ["a1", "a2", "a3"], index: 1 });
  });

  it("reports the first and last positions for the other variants", () => {
    expect(groupOf(buildThreadView(branched, "a1").groups, "a1")).toEqual({
      ids: ["a1", "a2", "a3"],
      index: 0,
    });
    expect(groupOf(buildThreadView(branched, "a3").groups, "a3")).toEqual({
      ids: ["a1", "a2", "a3"],
      index: 2,
    });
  });

  it("leaves the variants that are not on the path out of the group map", () => {
    const view = buildThreadView(branched, "a2");
    expect(groupOf(view.groups, "a1")).toBeUndefined();
    expect(groupOf(view.groups, "a3")).toBeUndefined();
    expect(Object.keys(view.groups)).toEqual(["a2"]);
  });

  it("does not give the user turn a sibling set", () => {
    const view = buildThreadView(branched, "a2");
    expect(groupOf(view.groups, "u1")).toBeUndefined();
  });
});

describe("buildThreadView: a branch that a later turn continues from", () => {
  // u1 → a1 (variant one) → u2 → a3, with a2 as the other answer to u1.
  const forked: Msg[] = [
    message("u1", null, "hi"),
    message("a1", "u1", "first answer"),
    message("a2", "u1", "second answer"),
    message("u2", "a1", "carry on"),
    message("a3", "u2", "continued"),
  ];

  it("follows the branch the active leaf belongs to", () => {
    const view = buildThreadView(forked, "a3");
    expect(texts(view.path)).toEqual(["hi", "first answer", "carry on", "continued"]);
    expect(groupOf(view.groups, "a1")).toEqual({ ids: ["a1", "a2"], index: 0 });
  });

  it("switches to the other branch without touching the other turn", () => {
    const view = buildThreadView(forked, "a2");
    expect(texts(view.path)).toEqual(["hi", "second answer"]);
    expect(groupOf(view.groups, "a2")).toEqual({ ids: ["a1", "a2"], index: 1 });
  });
});

describe("buildThreadView: choosing the leaf", () => {
  const branched: Msg[] = [
    message("u1", null, "hi"),
    message("a1", "u1", "first answer"),
    message("a2", "u1", "second answer"),
  ];

  it("follows the newest leaf when the server does not name one", () => {
    expect(texts(buildThreadView(branched, null).path)).toEqual(["hi", "second answer"]);
  });

  it("follows the newest leaf when activeLeafId is omitted entirely", () => {
    expect(texts(buildThreadView(branched, undefined).path)).toEqual(["hi", "second answer"]);
  });

  it("falls back to the newest leaf when activeLeafId names a message that is not here", () => {
    expect(texts(buildThreadView(branched, "not-a-message").path)).toEqual(["hi", "second answer"]);
  });

  it("prefers the server's leaf over the newest one", () => {
    expect(texts(buildThreadView(branched, "a1").path)).toEqual(["hi", "first answer"]);
  });
});

describe("buildThreadView: siblings declared but not sent", () => {
  it("counts declared variants that the list does not contain", () => {
    // The server sent only the active path; the total has to come from `variants`.
    const activeOnly: Msg[] = [
      message("u1", null, "hi"),
      message("a1", "u1", "second answer", ["a1", "a2", "a3"]),
    ];
    const view = buildThreadView(activeOnly, "a1");
    expect(texts(view.path)).toEqual(["hi", "second answer"]);
    expect(groupOf(view.groups, "a1")).toEqual({ ids: ["a1", "a2", "a3"], index: 0 });
  });

  it("accepts a declared set that omits the message itself", () => {
    const activeOnly: Msg[] = [
      message("u1", null, "hi"),
      message("a1", "u1", "second answer", ["a2", "a3"]),
    ];
    expect(groupOf(buildThreadView(activeOnly, "a1").groups, "a1")).toEqual({
      ids: ["a1", "a2", "a3"],
      index: 0,
    });
  });

  it("does not duplicate a sibling that is both present and declared", () => {
    const both: Msg[] = [
      message("u1", null, "hi"),
      message("a1", "u1", "first answer", ["a1", "a2"]),
      message("a2", "u1", "second answer", ["a1", "a2"]),
    ];
    expect(groupOf(buildThreadView(both, "a1").groups, "a1")).toEqual({
      ids: ["a1", "a2"],
      index: 0,
    });
  });

  it("shows no arrows for a single message that declares only itself", () => {
    const alone: Msg[] = [message("u1", null, "hi"), message("a1", "u1", "only answer", ["a1"])];
    expect(buildThreadView(alone, "a1").groups).toEqual({});
  });
});

describe("buildThreadView: malformed trees", () => {
  it("starts at a message whose parent is not in the list", () => {
    const orphaned: Msg[] = [message("a1", "missing-parent", "orphan answer")];
    expect(texts(buildThreadView(orphaned, "a1").path)).toEqual(["orphan answer"]);
  });

  it("stops instead of looping on a cycle", () => {
    const cyclic: Msg[] = [message("x", "y", "x"), message("y", "x", "y")];
    const view = buildThreadView(cyclic, "x");
    expect(view.path.length).toBeLessThanOrEqual(2);
    expect(texts(view.path)).toContain("x");
  });

  it("ignores a duplicate id rather than rendering it twice", () => {
    const duplicated: Msg[] = [
      message("u1", null, "hi"),
      message("a1", "u1", "Hello."),
      message("a1", "u1", "Hello again."),
    ];
    expect(texts(buildThreadView(duplicated, "a1").path)).toEqual(["hi", "Hello."]);
  });
});

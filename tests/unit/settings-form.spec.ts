import { describe, expect, it } from "vitest";
import {
  buildModelCatalog,
  describeCatalog,
  describeModelSource,
  type ModelCatalogResult,
  modelOptions,
  resolveDefaultModel,
} from "../../src/renderer/src/lib/models.js";
import {
  isDirty,
  keyStatus,
  missingKeyNote,
  normalizeBaseUrl,
  providerForm,
} from "../../src/renderer/src/lib/settings.js";

/**
 * The settings surface's decisions, without a screen.
 *
 * Three things here are load-bearing enough to be asserted exactly:
 *
 * 1. What goes on the wire when the base URL field is saved, and whether the draft is
 *    different from it — the "Unsaved changes" line has to mean something.
 * 2. How a `models.list` result becomes select options, and which source note it gets.
 *    A built-in list must never read as a live one.
 * 3. The tri-state around that fetch. Loading, empty, and failed are three different
 *    things to a user; collapsing any of them into "no models" hides a failure, which
 *    AGENTS.md forbids.
 */

function catalogResult(overrides: Partial<ModelCatalogResult> = {}): ModelCatalogResult {
  return { models: [], source: "remote", message: null, ...overrides };
}

describe("normalizeBaseUrl", () => {
  it("trims the field and strips the trailing slashes the transport would double", () => {
    expect(normalizeBaseUrl("  https://api.openai.com//  ")).toBe("https://api.openai.com");
  });

  it("treats an empty or whitespace-only field as not configured", () => {
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl("   ")).toBeNull();
    expect(normalizeBaseUrl("///")).toBeNull();
  });

  it("keeps a path, so a proxy prefix survives", () => {
    expect(normalizeBaseUrl("https://gateway.example/openai")).toBe(
      "https://gateway.example/openai",
    );
  });
});

describe("isDirty", () => {
  it("is false when the draft already matches what is saved", () => {
    expect(isDirty("https://api.openai.com", "https://api.openai.com")).toBe(false);
  });

  it("ignores a trailing slash the transport would discard anyway", () => {
    expect(isDirty("https://api.openai.com/", "https://api.openai.com")).toBe(false);
  });

  it("is true for a real change", () => {
    expect(isDirty("https://api.other.com", "https://api.openai.com")).toBe(true);
  });

  it("treats an empty draft and an unset URL as the same thing", () => {
    expect(isDirty("", null)).toBe(false);
    expect(isDirty("   ", null)).toBe(false);
  });

  it("is true when a draft appears over an unset URL", () => {
    expect(isDirty("https://api.openai.com", null)).toBe(true);
  });
});

describe("keyStatus", () => {
  it("renders main's masked tail exactly, without adding bullets of its own", () => {
    expect(keyStatus(true, "••••4321")).toBe("••••4321");
  });

  it("says no key is stored when none is", () => {
    expect(keyStatus(false, null)).toBe("No key stored.");
  });

  it("does not invent a tail when main withheld one for a short key", () => {
    expect(keyStatus(true, "••••")).toBe("••••");
    expect(keyStatus(true, null)).toBe("A key is stored.");
  });
});

describe("missingKeyNote", () => {
  it("states that no key will be sent and what that means upstream", () => {
    const note = missingKeyNote(false);
    expect(note).toContain("No key is stored.");
    expect(note).toContain("will not send one");
    expect(note).toContain("reject");
  });

  it("is absent when a key exists, so no empty paragraph is rendered", () => {
    expect(missingKeyNote(true)).toBeNull();
  });
});

describe("providerForm", () => {
  it("turns an unset base URL into an empty field rather than the word null", () => {
    expect(
      providerForm({ baseUrl: null, defaultModel: null, hasKey: false, masked: null }),
    ).toEqual({
      baseUrl: "",
      hasKey: false,
      masked: null,
    });
  });

  it("passes a saved value through untouched", () => {
    expect(
      providerForm({
        baseUrl: "https://api.openai.com",
        defaultModel: "gpt-4o-mini",
        hasKey: true,
        masked: "••••4321",
      }),
    ).toEqual({ baseUrl: "https://api.openai.com", hasKey: true, masked: "••••4321" });
  });
});

describe("modelOptions", () => {
  it("maps each model to an option and keeps the endpoint's order", () => {
    expect(
      modelOptions(
        catalogResult({
          models: [
            { id: "gpt-4o-mini", ownedBy: "openai" },
            { id: "gpt-4o", ownedBy: null },
          ],
        }),
      ),
    ).toEqual([
      { id: "gpt-4o-mini", ownedBy: "openai" },
      { id: "gpt-4o", ownedBy: null },
    ]);
  });

  it("drops duplicate ids, keeping the first occurrence", () => {
    expect(
      modelOptions(
        catalogResult({
          models: [
            { id: "gpt-4o", ownedBy: "first" },
            { id: "gpt-4o", ownedBy: "second" },
          ],
        }),
      ),
    ).toEqual([{ id: "gpt-4o", ownedBy: "first" }]);
  });

  it("adds the mock scenarios when the endpoint is the mock", () => {
    const ids = modelOptions(catalogResult({ source: "mock" })).map((option) => option.id);
    expect(ids).toContain("mock/text");
    expect(ids).toContain("mock/402");
    expect(ids).toContain("mock/429");
  });

  it("does not add mock ids to a fallback list: those ids are a guess about a real provider", () => {
    const ids = modelOptions(
      catalogResult({
        source: "fallback",
        models: [{ id: "gpt-4o-mini", ownedBy: null }],
        message: "connection refused",
      }),
    ).map((option) => option.id);
    expect(ids).toEqual(["gpt-4o-mini"]);
  });

  it("keeps mock ids the remote endpoint itself listed", () => {
    const ids = modelOptions(
      catalogResult({ models: [{ id: "mock/text", ownedBy: "cleon-mock" }] }),
    ).map((option) => option.id);
    expect(ids).toEqual(["mock/text"]);
  });
});

describe("describeModelSource", () => {
  it("says the list came from the endpoint when it did", () => {
    expect(describeModelSource("remote", null)).toBe(
      "Source: remote — read from the configured endpoint.",
    );
  });

  it("says a built-in list was used because the endpoint did not answer", () => {
    const note = describeModelSource("fallback", null);
    expect(note).toContain("Source: fallback");
    expect(note).toContain("built-in list");
    expect(note).toContain("did not answer");
  });

  it("appends the only detail there is when the remote call reported a message", () => {
    const note = describeModelSource("fallback", "getaddrinfo ENOTFOUND api.example");
    expect(note).toContain("did not answer");
    expect(note).toContain("getaddrinfo ENOTFOUND api.example");
  });

  it("says the endpoint is the mock rather than implying a real provider", () => {
    const note = describeModelSource("mock", null);
    expect(note).toContain("Source: mock");
    expect(note).toContain("mock server");
    expect(note).toContain("built-in scenarios");
  });
});

describe("buildModelCatalog", () => {
  it("is loading before the first answer arrives", () => {
    expect(buildModelCatalog({ loading: true, result: null, error: null })).toEqual({
      state: "loading",
    });
  });

  it("is loading when nothing has answered and nothing has failed", () => {
    expect(buildModelCatalog({ loading: false, result: null, error: null })).toEqual({
      state: "loading",
    });
  });

  it("keeps a failure distinct from an empty list", () => {
    const catalog = buildModelCatalog({
      loading: false,
      result: null,
      error: { code: "UPSTREAM_ERROR", message: "connection refused" },
    });
    expect(catalog.state).toBe("error");
    expect(catalog.state === "error" ? catalog.error.code : null).toBe("UPSTREAM_ERROR");
  });

  it("lets a failure win over a stale list, so a dead endpoint cannot look healthy", () => {
    const catalog = buildModelCatalog({
      loading: false,
      result: catalogResult({ models: [{ id: "gpt-4o", ownedBy: "openai" }] }),
      error: { code: "UPSTREAM_ERROR", message: "connection refused" },
    });
    expect(catalog.state).toBe("error");
  });

  it("is empty, with its source note, when the endpoint answered with nothing", () => {
    const catalog = buildModelCatalog({
      loading: false,
      result: catalogResult({ source: "fallback", message: "timed out" }),
      error: null,
    });
    expect(catalog.state).toBe("empty");
    if (catalog.state !== "empty") return;
    expect(catalog.source).toBe("fallback");
    expect(catalog.note).toContain("did not answer");
  });

  it("is ready with options when the endpoint answered", () => {
    const catalog = buildModelCatalog({
      loading: false,
      result: catalogResult({ models: [{ id: "gpt-4o-mini", ownedBy: null }] }),
      error: null,
    });
    expect(catalog.state).toBe("ready");
    if (catalog.state !== "ready") return;
    expect(catalog.options.map((option) => option.id)).toEqual(["gpt-4o-mini"]);
    expect(catalog.note).toBe("Source: remote — read from the configured endpoint.");
  });
});

describe("resolveDefaultModel", () => {
  const options = [
    { id: "a", ownedBy: null },
    { id: "b", ownedBy: null },
  ];

  it("keeps the stored model when the endpoint still lists it", () => {
    expect(resolveDefaultModel("b", options)).toBe("b");
  });

  it("falls back to the first model when the stored one is gone", () => {
    expect(resolveDefaultModel("retired-model", options)).toBe("a");
  });

  it("uses the first model when nothing was stored", () => {
    expect(resolveDefaultModel(null, options)).toBe("a");
    expect(resolveDefaultModel(undefined, options)).toBe("a");
  });

  it("returns null when there is nothing to pick", () => {
    expect(resolveDefaultModel("b", [])).toBeNull();
  });
});

describe("describeCatalog", () => {
  it("counts a ready list and marks a live one as good", () => {
    const line = describeCatalog({
      state: "ready",
      source: "remote",
      note: "Read from the configured endpoint.",
      options: [
        { id: "a", ownedBy: null },
        { id: "b", ownedBy: null },
      ],
    });
    expect(line.tone).toBe("ok");
    expect(line.text).toContain("2 models available");
    expect(line.text).toContain("Read from the configured endpoint.");
  });

  it("uses the singular for one model", () => {
    const line = describeCatalog({
      state: "ready",
      source: "remote",
      note: "n",
      options: [{ id: "only", ownedBy: null }],
    });
    expect(line.text).toContain("1 model available");
  });

  it("warns about a list the endpoint did not answer for", () => {
    const line = describeCatalog({
      state: "ready",
      source: "fallback",
      note: "built-in",
      options: [],
    });
    expect(line.tone).toBe("warn");
    expect(line.text).toContain("built-in");
  });

  it("shows the contract's own code for a failure", () => {
    const line = describeCatalog({
      state: "error",
      error: { code: "RATE_LIMITED", message: "slow down" },
    });
    expect(line.tone).toBe("bad");
    expect(line.text).toBe("RATE_LIMITED: slow down");
  });

  it("says it is still loading rather than pretending the list is empty", () => {
    expect(describeCatalog({ state: "loading" })).toEqual({
      tone: "muted",
      text: "Loading models…",
    });
  });
});

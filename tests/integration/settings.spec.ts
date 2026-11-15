import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MOCK_BASE_URL, resolveBaseUrl } from "../../src/main/api/client.js";
import { listModels } from "../../src/main/api/models.js";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";
import { getSettings, setSettings } from "../../src/main/db/repo.js";
import { contracts } from "../../src/shared/ipc-contract";

/**
 * P0 provider settings against a real SQLite file, plus the catalog read that
 * depends on them.
 *
 * Nothing is mocked at the database layer: the upsert, the conflict clause and the
 * `updated_at` default are all database behaviour, and a mock would happily agree
 * with a statement SQLite rejects. The network *is* stubbed — every fetch here is
 * injected, which is the only way to prove the mock path makes no call at all and
 * to exercise the failure paths without waiting for a real timeout.
 *
 * The handler record itself lives in `src/main/index.ts`, which imports Electron and
 * is therefore not importable here. What is tested is the same chain the handler
 * runs: stored settings -> resolver -> catalog.
 */

/** The mock server's catalog, pinned. `mock/**` is frozen; this test is the guard. */
const MOCK_IDS = [
  "mock/text",
  "mock/reasoning",
  "mock/tool",
  "mock/truncated",
  "mock/402",
  "mock/429",
];

let tempDir = "";
let conn: Db;
let db: DrizzleDb;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cleon-p0-"));
  conn = openDatabase(join(tempDir, "cleon.db"));
  db = createDb(conn);
});

afterAll(async () => {
  closeDatabase();
  if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  conn.exec("DELETE FROM settings;");
});

function settingRow(key: string): { value: string; updated_at: string } | undefined {
  return conn.prepare("SELECT value, updated_at FROM settings WHERE key = ?").get(key) as
    | { value: string; updated_at: string }
    | undefined;
}

function settingCount(): number {
  const row = conn.prepare("SELECT count(*) AS n FROM settings").get() as { n: number };
  return row.n;
}

describe("settings storage", () => {
  it("reports nothing configured before anything is written", () => {
    expect(getSettings(db)).toEqual({ baseUrl: null, defaultModel: null, embeddingModel: null });
  });

  it("round-trips both keys", () => {
    setSettings(db, { baseUrl: "https://api.example.com", defaultModel: "gpt-4o" });

    expect(getSettings(db)).toEqual({
      baseUrl: "https://api.example.com",
      defaultModel: "gpt-4o",
      embeddingModel: null,
    });
    expect(settingRow("base_url")?.value).toBe("https://api.example.com");
    expect(settingRow("default_model")?.value).toBe("gpt-4o");
  });

  it("upserts in place and moves updated_at, instead of adding a second row", () => {
    setSettings(db, { baseUrl: "https://first.example.com" });

    // Backdate the row so "the write moved the timestamp" is a real assertion
    // rather than a race against the clock's resolution.
    const backdated = "2020-01-01T00:00:00.000Z";
    conn.prepare("UPDATE settings SET updated_at = ? WHERE key = ?").run(backdated, "base_url");

    setSettings(db, { baseUrl: "https://second.example.com" });

    const row = settingRow("base_url");
    expect(settingCount()).toBe(1);
    expect(row?.value).toBe("https://second.example.com");
    expect((row?.updated_at ?? "") > backdated).toBe(true);
  });

  it("leaves the key that was not in the patch alone", () => {
    setSettings(db, { baseUrl: "https://api.example.com", defaultModel: "gpt-4o" });

    const after = setSettings(db, { baseUrl: "https://other.example.com" });

    expect(after).toEqual({
      baseUrl: "https://other.example.com",
      defaultModel: "gpt-4o",
      embeddingModel: null,
    });
    expect(settingRow("default_model")?.value).toBe("gpt-4o");
  });

  it("does nothing at all for an empty patch", () => {
    setSettings(db, { baseUrl: "https://api.example.com" });

    expect(setSettings(db, {})).toEqual({
      baseUrl: "https://api.example.com",
      defaultModel: null,
      embeddingModel: null,
    });
    expect(settingRow("base_url")?.value).toBe("https://api.example.com");
  });

  it("clears a key when the patch says null, and keeps the other one", () => {
    setSettings(db, { baseUrl: "https://api.example.com", defaultModel: "gpt-4o" });

    const after = setSettings(db, { baseUrl: null });

    expect(after).toEqual({ baseUrl: null, defaultModel: "gpt-4o", embeddingModel: null });
    expect(settingRow("base_url")).toBeUndefined();
    expect(settingRow("default_model")?.value).toBe("gpt-4o");
  });

  it("treats a blank value as a clear, and trims what it stores", () => {
    // An empty string stored verbatim would read back as "configured" to the settings
    // screen while the resolver treated it as unset — two answers to one question.
    expect(setSettings(db, { baseUrl: "   ", defaultModel: "  gpt-4o  " })).toEqual({
      baseUrl: null,
      defaultModel: "gpt-4o",
      embeddingModel: null,
    });
    expect(settingRow("base_url")).toBeUndefined();
  });

  /**
   * D8: the embedding model is the third key. Its own case, because the thing that can go
   * wrong is different from the other two: retrieval reads it through a default, so "stored
   * but blank" must not be the same state as "stored and set".
   */
  it("round-trips the embedding model, and clears it back to unset", () => {
    expect(setSettings(db, { embeddingModel: "  text-embedding-3-large  " }).embeddingModel).toBe(
      "text-embedding-3-large",
    );
    expect(settingRow("embedding_model")?.value).toBe("text-embedding-3-large");

    // Null and blank both clear: the resolver's default is what "unset" means, and an
    // empty row would make `embeddingModel` read as "" to a caller that does not apply it.
    expect(setSettings(db, { embeddingModel: null }).embeddingModel).toBeNull();
    expect(settingRow("embedding_model")).toBeUndefined();

    setSettings(db, { embeddingModel: "text-embedding-3-small" });
    expect(setSettings(db, { embeddingModel: "   " }).embeddingModel).toBeNull();
  });
});

describe("models.list", () => {
  it("serves the mock catalog without touching the network", async () => {
    // The chain the handler runs, end to end: what Settings stored, resolved, then
    // read. Packaged, because that is the case where a wrong answer would ship.
    setSettings(db, { baseUrl: MOCK_BASE_URL });
    const stored = getSettings(db);
    const baseUrl = resolveBaseUrl({
      isPackaged: true,
      env: {},
      storedBaseUrl: stored.baseUrl,
    });

    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new Error("the mock catalog must not be fetched");
    };

    const result = await listModels({ baseUrl, apiKey: null, fetchImpl });

    expect(calls).toBe(0);
    expect(result.source).toBe("mock");
    expect(result.message).toBeNull();
    expect(result.models.map((model) => model.id)).toEqual(MOCK_IDS);
    expect(result.models.every((model) => model.ownedBy === "cleon-mock")).toBe(true);
    expect(() => contracts["models.list"].response.parse(result)).not.toThrow();
  });

  it("reads a remote catalog and fills in the owner the provider omitted", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-x", object: "model", owned_by: "openai" },
            { id: "gpt-y", object: "model", owned_by: null },
            { id: "local-z", object: "model" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const result = await listModels({
      baseUrl: "https://api.example.com",
      apiKey: null,
      fetchImpl,
    });

    expect(result.source).toBe("remote");
    expect(result.message).toBeNull();
    expect(result.models).toEqual([
      { id: "gpt-x", ownedBy: "openai" },
      { id: "gpt-y", ownedBy: null },
      { id: "local-z", ownedBy: null },
    ]);
    expect(() => contracts["models.list"].response.parse(result)).not.toThrow();
  });

  it("requests /v1/models with a deadline, and sends a bearer only when a key exists", async () => {
    const calls: { url: string; headers: Headers; signal: AbortSignal | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        signal: init?.signal ?? null,
      });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    await listModels({ baseUrl: "https://api.example.com", apiKey: null, fetchImpl });
    await listModels({ baseUrl: "https://api.example.com", apiKey: "sk-test-key", fetchImpl });

    const anonymous = calls[0];
    const authenticated = calls[1];

    expect(anonymous?.url).toBe("https://api.example.com/v1/models");
    expect(anonymous?.headers.get("authorization")).toBeNull();
    expect(authenticated?.headers.get("authorization")).toBe("Bearer sk-test-key");

    // A deadline exists and is not already spent. Waiting five seconds for the real
    // one would test the clock, not the wiring.
    expect(anonymous?.signal).toBeInstanceOf(AbortSignal);
    expect(anonymous?.signal?.aborted).toBe(false);
  });

  it("keeps an empty remote answer as an answer rather than calling it a failure", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });

    const result = await listModels({
      baseUrl: "https://api.example.com",
      apiKey: null,
      fetchImpl,
    });

    // A provider with no models is a valid, if useless, provider. Inventing a
    // fallback here would hide the only signal the user has.
    expect(result).toEqual({ models: [], source: "remote", message: null });
  });

  it("degrades to the fallback list, naming the status, when the provider refuses", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 401 });

    const result = await listModels({
      baseUrl: "https://api.example.com",
      apiKey: "sk-rejected",
      fetchImpl,
    });

    expect(result.source).toBe("fallback");
    expect(result.message).toContain("401");
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every((model) => model.ownedBy === null)).toBe(true);
    expect(() => contracts["models.list"].response.parse(result)).not.toThrow();
  });

  it("degrades when the body is not the expected shape", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ models: ["gpt-x"] }), { status: 200 });

    const result = await listModels({
      baseUrl: "https://api.example.com",
      apiKey: null,
      fetchImpl,
    });

    expect(result.source).toBe("fallback");
    expect(result.message).toContain("expected shape");
  });

  it("describes a timeout as the wait the user sat through", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };

    const result = await listModels({
      baseUrl: "https://api.example.com",
      apiKey: null,
      fetchImpl,
    });

    expect(result.source).toBe("fallback");
    expect(result.message).toContain("5 seconds");
  });

  it("never throws, even when the transport itself fails", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const result = await listModels({
      baseUrl: "https://api.example.com",
      apiKey: null,
      fetchImpl,
    });

    // This feeds a settings screen. A thrown error here would take the screen down
    // with it, including the fields the user needs to fix the problem.
    expect(result.source).toBe("fallback");
    expect(result.message).toContain("fetch failed");
  });
});

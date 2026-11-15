import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenerationBus } from "../../src/main/api/bus.js";
import { GenerationService } from "../../src/main/api/generations.js";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";
import { getThreadTree } from "../../src/main/db/repo.js";
import { AppError } from "../../src/main/errors.js";
import { KnowledgeService } from "../../src/main/knowledge/service.js";
import { contracts } from "../../src/shared/ipc-contract";

/**
 * The knowledge base against a real SQLite file and a real HTTP server.
 *
 * The embedding endpoint is `mock/server.mjs`, spawned the way a user's dev environment runs
 * it — so what is proven here is the whole path: the HTTP request, the response shape, the
 * vector bytes in the BLOB, the cosine scan, and the ranking. Nothing is stubbed except the
 * fake fetch that returns a *different* width, which exists to prove the incomparability
 * refusal rather than to avoid work.
 *
 * The mock's vectors are bag-of-token hashes (see `mock/server.mjs`), which is what makes
 * "the exact phrase ranks its own chunk first" a claim rather than a coin flip.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MOCK_SERVER = resolve(ROOT, "mock/server.mjs");

/** Distinctive vocabulary per document: a shared word would blur which chunk won. */
const SOLAR = `# Solar array

The peak output of the inverter is 5.8 kilowatts at noon, measured on the south roof.
Above 45 degrees celsius the derating curve drops sharply and the array gives back
roughly a fifth of that figure.

The battery bank holds twelve kilowatt hours. It charges from the string of nine
panels and discharges through the inverter overnight.
`;

const COFFEE = `# Grinder notes

The burr setting for pour over coffee is eighteen clicks from zero. Finer than that
and the paper filter clogs; coarser and the water runs straight through the grounds.

Espresso wants nine clicks. The shot should taste of cocoa and stone fruit, not ash.
`;

const TAXES = `# Filing checklist

Gather receipts for the fiscal year. The accountant needs every invoice above forty
euros, sorted by quarter, plus the bank statements for the business account.

File before the thirty-first of march to avoid the late penalty.
`;

let mock: ChildProcess | undefined;
let base = "";
let tempDir = "";
let sourceDir = "";
let rootDir = "";
let conn: Db;
let db: DrizzleDb;
let service: KnowledgeService;

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
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("mock server did not become healthy");
}

/** A file to index, written under the sources directory. */
async function sourceFile(name: string, contents: string): Promise<string> {
  const path = join(sourceDir, name);
  await writeFile(path, contents);
  return path;
}

/** A service pointed at the mock, so every call goes through the real transport. */
function mockService(overrides: { rootDir?: string } = {}): KnowledgeService {
  return new KnowledgeService({
    db,
    rootDir: overrides.rootDir ?? rootDir,
    resolveConfig: async () => ({
      config: { baseUrl: base, apiKey: null },
      model: "mock/embed",
    }),
  });
}

function chunkCount(documentId: string): number {
  const row = conn
    .prepare("SELECT count(*) AS n FROM chunks WHERE document_id = ?")
    .get(documentId) as { n: number } | undefined;
  return row?.n ?? 0;
}

function expectAppError(run: () => Promise<unknown>, code: string): Promise<AppError> {
  return run().then(
    () => {
      throw new Error(`expected ${code}, but nothing was thrown`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(code);
      return appError;
    },
  );
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mock = spawn(process.execPath, [MOCK_SERVER], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  await waitForHealth();

  tempDir = await mkdtemp(join(tmpdir(), "cleon-d8-kb-"));
  sourceDir = join(tempDir, "sources");
  rootDir = join(tempDir, "knowledge");
  await mkdir(sourceDir, { recursive: true });
  conn = openDatabase(join(tempDir, "cleon.db"));
  db = createDb(conn);
}, 30_000);

afterAll(async () => {
  closeDatabase();
  mock?.kill();
  if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test starts from an empty corpus and an empty directory: "delete removed the copy"
  // reads the directory, and a file from another test would be indistinguishable from a leak.
  conn.exec("DELETE FROM documents;");
  await rm(rootDir, { recursive: true, force: true });
  service = mockService();
});

describe("ingest", () => {
  it("writes the document, its chunks, and a copy of the file", async () => {
    const path = await sourceFile("solar.md", SOLAR);

    const [document] = await service.addDocuments([path]);
    expect(document).toBeDefined();
    if (document === undefined) return;

    // The row as the contract describes it, parsed rather than eyeballed.
    expect(() =>
      contracts["kb.listDocuments"].response.parse({ items: [document], total: 1 }),
    ).not.toThrow();
    expect(document).toMatchObject({
      title: "solar.md",
      mime: "text/markdown",
      sourcePath: path,
      bytes: Buffer.byteLength(SOLAR),
    });

    // The chunk rows are real rows, and the count on the document agrees with them.
    const stored = chunkCount(document.id);
    expect(stored).toBeGreaterThan(0);
    expect(document.chunkCount).toBe(stored);

    // The original is untouched; the copy is the one this app owns, named by document id.
    expect(await readFile(path, "utf8")).toBe(SOLAR);
    const copies = await readdir(rootDir);
    expect(copies).toEqual([`${document.id}.md`]);
    expect(await readFile(join(rootDir, `${document.id}.md`), "utf8")).toBe(SOLAR);
  });

  it("indexes several files in one call", async () => {
    const paths = await Promise.all([
      sourceFile("solar.md", SOLAR),
      sourceFile("coffee.md", COFFEE),
      sourceFile("taxes.txt", TAXES),
    ]);

    const documents = await service.addDocuments(paths);

    expect(documents).toHaveLength(3);
    expect(service.list().total).toBe(3);
    expect(documents.every((document) => document.chunkCount > 0)).toBe(true);
  });

  it("refuses the same file twice, instead of paying to embed it again", async () => {
    const path = await sourceFile("solar.md", SOLAR);
    await service.addDocuments([path]);

    const error = await expectAppError(() => service.addDocuments([path]), "CONFLICT");

    expect(error.details).toMatchObject({ reason: "already_indexed", sourcePath: path });
    // The first document is still the only one, and its copy was not orphaned by the retry.
    expect(service.list().total).toBe(1);
    expect(await readdir(rootDir)).toHaveLength(1);
  });

  it("refuses a PDF by name, rather than indexing bytes as if they were text", async () => {
    // A PDF is attachable (`kindForFilename` says `document`) but its bytes are compressed
    // streams. Indexing them would produce a document that chunks and retrieves garbage, and
    // nothing in the result would say so.
    const path = await sourceFile("paper.pdf", "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

    const error = await expectAppError(() => service.addDocuments([path]), "BAD_REQUEST");

    expect(error.details).toMatchObject({ reason: "not_readable_text", filename: "paper.pdf" });
    expect(await readdir(rootDir).catch(() => [] as string[])).toEqual([]);
  });

  it("refuses a file with no text, and leaves nothing behind", async () => {
    const path = await sourceFile("blank.md", "   \n\n \t\n");

    const error = await expectAppError(() => service.addDocuments([path]), "BAD_REQUEST");

    expect(error.details).toMatchObject({ reason: "empty_document", filename: "blank.md" });
    expect(service.list().total).toBe(0);
    expect(await readdir(rootDir).catch(() => [] as string[])).toEqual([]);
  });

  it("refuses an extension the attachment table does not know", async () => {
    const path = await sourceFile("archive.zip", "PK\u0003\u0004");

    const error = await expectAppError(() => service.addDocuments([path]), "BAD_REQUEST");

    expect(error.details).toMatchObject({ reason: "unsupported_type", filename: "archive.zip" });
  });

  it("leaves the corpus unchanged when the embedding provider fails", async () => {
    // The provider is unreachable: the file is copied, then the embed call fails, and the
    // copy must be removed — a document that is not indexed is not a document with a copy.
    const path = await sourceFile("solar.md", SOLAR);
    const offline = new KnowledgeService({
      db,
      rootDir,
      resolveConfig: async () => ({
        config: { baseUrl: "http://127.0.0.1:1", apiKey: null },
        model: "mock/embed",
      }),
    });

    await expect(offline.addDocuments([path])).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(service.list().total).toBe(0);
    expect(chunkCount("any")).toBe(0);
    expect(await readdir(rootDir).catch(() => [] as string[])).toEqual([]);
  });
});

describe("search", () => {
  it("ranks the chunk that contains the exact phrase first", async () => {
    const paths = await Promise.all([
      sourceFile("solar.md", SOLAR),
      sourceFile("coffee.md", COFFEE),
      sourceFile("taxes.txt", TAXES),
    ]);
    const documents = await service.addDocuments(paths);
    const solar = documents.find((document) => document.title === "solar.md");

    const hits = await service.search({ query: "peak output of the inverter", limit: 5 });

    expect(hits.length).toBeGreaterThan(0);
    const best = hits[0];
    expect(best).toBeDefined();
    if (best === undefined || solar === undefined) return;

    expect(best.documentId).toBe(solar.id);
    expect(best.text).toContain("peak output of the inverter");
    // A real score, not a placeholder: the phrase shares most of its tokens with the chunk.
    expect(best.score).toBeGreaterThan(0);
    // And the ranking is monotonically non-increasing, which is the whole promise of "best
    // first".
    for (let index = 1; index < hits.length; index += 1) {
      expect((hits[index]?.score ?? 0) <= (hits[index - 1]?.score ?? 0)).toBe(true);
    }
  });

  it("returns hits in the contract's shape, with the score in range", async () => {
    const path = await sourceFile("coffee.md", COFFEE);
    await service.addDocuments([path]);

    const hits = await service.search({ query: "burr setting for pour over", limit: 3 });

    expect(hits.length).toBeGreaterThan(0);
    expect(() => contracts["kb.search"].response.parse({ chunks: hits })).not.toThrow();
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThanOrEqual(-1);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    expect(hits[0]?.text).toContain("burr setting");
  });

  it("narrows to the documents it was given", async () => {
    const [solarPath, coffeePath] = await Promise.all([
      sourceFile("solar.md", SOLAR),
      sourceFile("coffee.md", COFFEE),
    ]);
    const documents = await service.addDocuments([solarPath, coffeePath]);
    const coffee = documents.find((document) => document.title === "coffee.md");
    expect(coffee).toBeDefined();
    if (coffee === undefined) return;

    // The question is about the solar array; scoping to the coffee document must not answer
    // it, which is the point of scoping at all.
    const scoped = await service.search({
      query: "peak output of the inverter",
      limit: 5,
      documentIds: [coffee.id],
    });

    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((hit) => hit.documentId === coffee.id)).toBe(true);
  });

  it("honours the limit", async () => {
    const path = await sourceFile("solar.md", SOLAR);
    await service.addDocuments([path]);

    expect(await service.search({ query: "battery", limit: 1 })).toHaveLength(1);
  });

  it("is an empty list for an empty corpus, not an error", async () => {
    expect(await service.search({ query: "anything at all", limit: 5 })).toEqual([]);
  });

  it("refuses to compare vectors from a different embedding model, and says which", async () => {
    // Indexed at the mock's 64 dimensions, then queried with a model that returns three. A
    // silent empty result would read as "your documents do not mention that", which is a
    // different and misleading answer.
    const path = await sourceFile("solar.md", SOLAR);
    await service.addDocuments([path]);

    const threeDimensional: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const otherModel = new KnowledgeService({
      db,
      rootDir,
      resolveConfig: async () => ({
        config: { baseUrl: base, apiKey: null },
        model: "some-other-model",
      }),
      fetchImpl: threeDimensional,
    });

    const error = await expectAppError(
      () => otherModel.search({ query: "peak output", limit: 5 }),
      "CONFLICT",
    );
    expect(error.details).toMatchObject({ reason: "embedding_dimension_mismatch", dim: 3 });
  });
});

describe("delete", () => {
  it("removes the document, cascades its chunks, and deletes the copy", async () => {
    const path = await sourceFile("solar.md", SOLAR);
    const [document] = await service.addDocuments([path]);
    expect(document).toBeDefined();
    if (document === undefined) return;

    expect(chunkCount(document.id)).toBeGreaterThan(0);
    expect(await readdir(rootDir)).toHaveLength(1);

    expect(await service.deleteDocuments(document.id)).toEqual({ ok: true });

    // The rows are gone, by cascade rather than by a second delete statement.
    expect(chunkCount(document.id)).toBe(0);
    expect(service.list().total).toBe(0);
    const orphan = conn
      .prepare("SELECT count(*) AS n FROM chunks WHERE document_id = ?")
      .get(document.id) as { n: number };
    expect(orphan.n).toBe(0);

    // And the bytes are gone with them: a copy nobody points at is a leak that grows.
    expect(await readdir(rootDir).catch(() => [] as string[])).toEqual([]);

    // Search no longer finds it.
    expect(await service.search({ query: "peak output of the inverter", limit: 5 })).toEqual([]);
  });

  it("is NOT_FOUND the second time, rather than reporting success twice", async () => {
    const path = await sourceFile("solar.md", SOLAR);
    const [document] = await service.addDocuments([path]);
    expect(document).toBeDefined();
    if (document === undefined) return;

    await service.deleteDocuments(document.id);

    const error = await expectAppError(() => service.deleteDocuments(document.id), "NOT_FOUND");
    expect(error.details).toEqual({ documentId: document.id });
  });
});

describe("reading a chunk back", () => {
  it("returns the stored text for expanding a citation", async () => {
    const path = await sourceFile("solar.md", SOLAR);
    await service.addDocuments([path]);
    const hits = await service.search({ query: "peak output of the inverter", limit: 1 });
    const chunkId = hits[0]?.chunkId;
    expect(chunkId).toBeDefined();
    if (chunkId === undefined) return;

    const chunk = service.readChunk(chunkId);

    expect(chunk.chunkId).toBe(chunkId);
    expect(chunk.documentTitle).toBe("solar.md");
    expect(chunk.text).toContain("peak output of the inverter");
    expect(() => contracts["kb.readChunk"].response.parse({ chunk })).not.toThrow();
  });

  it("is NOT_FOUND for a chunk that no longer exists", () => {
    let caught: unknown;
    try {
      service.readChunk("9f8a2f1e-0000-4000-8000-000000000000");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });
});

describe("the schema this slice relies on", () => {
  it("has migration 7 applied, with the four tables and the citation column", () => {
    const latest = conn.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number | null;
    };
    expect(latest.v).toBeGreaterThanOrEqual(7);

    const names = (
      conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);

    for (const table of ["documents", "chunks", "artifacts", "artifact_versions"]) {
      expect(names).toContain(table);
    }

    const messageColumns = (
      conn.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(messageColumns).toContain("citations_json");
  });

  it("refuses two chunks with the same ordinal in one document", () => {
    // The uniqueness is the chunking contract made durable: a re-index cannot half-overwrite
    // an existing document's chunks.
    const documentId = "3f6b6a2c-1111-4000-8000-000000000001";
    conn
      .prepare(
        "INSERT INTO documents (id, title, source_path, mime, bytes, chunk_count) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(documentId, "x.md", "/tmp/x.md", "text/markdown", 1, 1);

    const insert = conn.prepare(
      "INSERT INTO chunks (id, document_id, ordinal, text, embedding, dim) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("3f6b6a2c-1111-4000-8000-000000000002", documentId, 0, "one", Buffer.alloc(4), 1);

    expect(() =>
      insert.run("3f6b6a2c-1111-4000-8000-000000000003", documentId, 0, "two", Buffer.alloc(4), 1),
    ).toThrow();

    conn.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
  });
});

/**
 * D8's decision 6, at the seam that matters: `chat.send` with `useKnowledge`.
 *
 * The knowledge service is the real one (same database, same mock embedding endpoint), so
 * what is proven is the whole chain: retrieval runs before the turn is written, the prompt
 * the provider receives begins with the numbered excerpts, and the citation list is
 * persisted on the assistant row — because that is the only thing that makes the chips
 * survive a relaunch.
 */
describe("chat.send with knowledge", () => {
  interface CapturedRequest {
    model: string;
    messages: { role: string; content: string }[];
  }

  /** The turn, with the request body captured as it goes out. */
  function createTurn(
    knowledge: KnowledgeService,
    captured: { body: CapturedRequest | null },
  ): GenerationService {
    const capturing: typeof fetch = async (input, init) => {
      const body = init?.body;
      if (typeof body === "string") captured.body = JSON.parse(body) as CapturedRequest;
      return fetch(input, init);
    };

    return new GenerationService({
      db,
      bus: new GenerationBus(),
      resolveConfig: async () => ({ baseUrl: base, apiKey: null }),
      knowledge: { retrieve: (input) => knowledge.retrieve(input) },
      fetchImpl: capturing,
    });
  }

  it("retrieves first, prepends numbered excerpts, and persists the citations", async () => {
    const path = await sourceFile("solar.md", SOLAR);
    await service.addDocuments([path]);

    const captured: { body: CapturedRequest | null } = { body: null };
    const turn = createTurn(service, captured);

    const sent = await turn.send(
      {
        threadId: null,
        text: "what is the peak output of the inverter?",
        model: "mock/text",
        useKnowledge: true,
      },
      () => undefined,
    );

    // The response carries the citations, so the chips render on the live turn.
    expect(sent.citations).toBeDefined();
    expect(sent.citations?.length).toBeGreaterThan(0);
    expect(() => contracts["chat.send"].response.parse(sent)).not.toThrow();

    // The prompt begins with the knowledge block, before the user's own text.
    const messages = captured.body?.messages ?? [];
    const system = messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content ?? "").toContain("[1] solar.md");
    expect(system?.content ?? "").toContain("peak output of the inverter");
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "what is the peak output of the inverter?",
    });

    // And the row on disk carries the same list, which is what `chat.thread` replays.
    const tree = getThreadTree(db, sent.threadId);
    const assistant = tree?.messages.find((message) => message.id === sent.assistantMessageId);
    expect(assistant?.citations.length).toBeGreaterThan(0);
    expect(assistant?.citations[0]?.documentTitle).toBe("solar.md");
    expect(assistant?.citations[0]?.chunkId).toBe(sent.citations?.[0]?.chunkId);
  });

  it("scopes retrieval to the documents the turn names", async () => {
    const [solarPath, coffeePath] = await Promise.all([
      sourceFile("solar.md", SOLAR),
      sourceFile("coffee.md", COFFEE),
    ]);
    const documents = await service.addDocuments([solarPath, coffeePath]);
    const coffee = documents.find((document) => document.title === "coffee.md");
    expect(coffee).toBeDefined();
    if (coffee === undefined) return;

    const captured: { body: CapturedRequest | null } = { body: null };
    const turn = createTurn(service, captured);

    const sent = await turn.send(
      {
        threadId: null,
        text: "what is the peak output of the inverter?",
        model: "mock/text",
        useKnowledge: true,
        documentIds: [coffee.id],
      },
      () => undefined,
    );

    expect(sent.citations?.every((citation) => citation.documentId === coffee.id)).toBe(true);
  });

  it("writes no citations and no system message when the turn does not ask", async () => {
    const path = await sourceFile("solar.md", SOLAR);
    await service.addDocuments([path]);

    const captured: { body: CapturedRequest | null } = { body: null };
    const turn = createTurn(service, captured);

    const sent = await turn.send(
      { threadId: null, text: "hello", model: "mock/text" },
      () => undefined,
    );

    expect(sent.citations).toBeUndefined();
    expect((captured.body?.messages ?? []).every((message) => message.role !== "system")).toBe(
      true,
    );

    const tree = getThreadTree(db, sent.threadId);
    const assistant = tree?.messages.find((message) => message.id === sent.assistantMessageId);
    expect(assistant?.citations).toEqual([]);
  });

  it("refuses the turn before writing anything when the corpus is not comparable", async () => {
    // Indexed at 64 dimensions, queried by a 3-dimension model: the retrieval is refused, and
    // that refusal happens before the message rows exist. A turn that was written and then
    // answered without the context it asked for is the failure this ordering prevents.
    const path = await sourceFile("solar.md", SOLAR);
    await service.addDocuments([path]);

    const threeDimensional: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const mismatched = new KnowledgeService({
      db,
      rootDir,
      resolveConfig: async () => ({ config: { baseUrl: base, apiKey: null }, model: "other" }),
      fetchImpl: threeDimensional,
    });

    const captured: { body: CapturedRequest | null } = { body: null };
    const turn = createTurn(mismatched, captured);

    // Counted per test rather than asserted at zero: the turns from earlier cases are still
    // in this database, and "nothing was written" has to be about *this* send.
    const before = (conn.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;

    await expect(
      turn.send(
        { threadId: null, text: "peak output?", model: "mock/text", useKnowledge: true },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Nothing was written: no message rows, and the chat request never went out.
    const after = (conn.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(captured.body).toBeNull();
  });
});

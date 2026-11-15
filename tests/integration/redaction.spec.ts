import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GenerationBus } from "../../src/main/api/bus.js";
import { streamChatCompletion } from "../../src/main/api/client.js";
import { type ChatSendRequest, GenerationService } from "../../src/main/api/generations.js";
import { attachmentsRoot, createAttachmentHandlers } from "../../src/main/attachments/handlers.js";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase } from "../../src/main/db/index.js";
import { getThreadTree } from "../../src/main/db/repo.js";
import { saveArtifact } from "../../src/main/db/repo-artifacts.js";
import { KnowledgeService } from "../../src/main/knowledge/service.js";
import { McpManager } from "../../src/main/mcp/manager.js";
import { type SecretBackend, type SecretStore, SecretsService } from "../../src/main/secrets.js";
import type { GenerationEvent } from "../../src/shared/ipc-contract";

/**
 * The product's central claim is that the API key never leaves the main process.
 * These tests try to falsify it with a canary string: if the key can be found in
 * a persisted byte, a masked value, a URL or a request body, they fail.
 *
 * The canary is deliberately shaped like a real key so a naive redaction that only
 * strips a prefix still gets caught.
 */
const CANARY = "sk-CANARY-9f3a2b7c1d4e5f60718293a4b5c6d7e8f9012345";

class ReversingBackend implements SecretBackend {
  available(): boolean {
    return true;
  }
  encrypt(plain: string): string {
    return Buffer.from(plain, "utf8").toString("base64");
  }
  decrypt(cipher: string): string {
    return Buffer.from(cipher, "base64").toString("utf8");
  }
}

function fileStore(dir: string): SecretStore {
  const file = join(dir, "secret.bin");
  return {
    async read() {
      try {
        return await readFile(file, "utf8");
      } catch {
        return null;
      }
    },
    async write(value: string) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, value, { mode: 0o600 });
    },
    async clear() {
      const { unlink } = await import("node:fs/promises");
      await unlink(file).catch(() => undefined);
    },
  };
}

/** Every byte of every file in the directory, concatenated as latin1 for a raw scan. */
async function allBytes(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push((await readFile(path)).toString("latin1"));
    }
  };
  await walk(dir);
  return out.join("\n");
}

/** The files under `dir`, by relative path, so a leak can name the file it is in. */
async function filesUnder(dir: string, prefix = ""): Promise<[string, string][]> {
  const found: [string, string][] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(dir, relative)));
      continue;
    }
    if (!entry.isFile()) continue;
    found.push([relative, (await readFile(join(dir, relative))).toString("latin1")]);
  }
  return found;
}

describe("secret redaction", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function service(): Promise<{ svc: SecretsService; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "cleon-redact-"));
    dirs.push(dir);
    return { svc: new SecretsService(new ReversingBackend(), fileStore(dir)), dir };
  }

  it("round-trips the key, so the later assertions are not vacuous", async () => {
    const { svc } = await service();
    await svc.setApiKey(CANARY);
    expect(await svc.getApiKey()).toBe(CANARY);
    expect(await svc.hasKey()).toBe(true);
  });

  it("stores ciphertext only — the plaintext key is nowhere on disk", async () => {
    const { svc, dir } = await service();
    await svc.setApiKey(CANARY);

    const raw = await allBytes(dir);
    expect(raw).not.toContain(CANARY);
    // And the storage is genuinely encrypted, not merely absent.
    expect(raw).toContain(new ReversingBackend().encrypt(CANARY));
  });

  it("never puts the key in the masked value", async () => {
    const { svc } = await service();
    await svc.setApiKey(CANARY);

    const masked = await svc.masked();
    expect(masked).toBe(`••••${CANARY.slice(-4)}`);
    expect(masked).not.toContain(CANARY.slice(0, -4));
  });

  it("sends the key as a Bearer header only — never in the URL or the body", async () => {
    const { svc, dir } = await service();
    await svc.setApiKey(CANARY);

    const seen: { url: string; body: string; auth: string | null }[] = [];

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
        auth: new Headers(init?.headers).get("authorization"),
      });
      // 402 so the client maps an error and returns quickly; we only care about the request.
      return new Response(JSON.stringify({ error: { code: "BUDGET_EXCEEDED", message: "no" } }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const outcome = await streamChatCompletion({
      config: { baseUrl: "http://127.0.0.1:4790", apiKey: CANARY },
      model: "mock/text",
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onDelta: () => undefined,
      fetchImpl: fakeFetch,
    }).catch((err: unknown) => err);

    expect(seen).toHaveLength(1);
    const request = seen[0];
    if (!request) throw new Error("no request captured");
    expect(request.auth).toBe(`Bearer ${CANARY}`);
    expect(request.url).not.toContain(CANARY);
    expect(request.body).not.toContain(CANARY);

    // Whatever came back — an outcome or a thrown AppError — must not echo the key.
    expect(JSON.stringify(outcome)).not.toContain(CANARY);

    // Nothing on disk gained the key either.
    expect(await allBytes(dir)).not.toContain(CANARY);
  });
});

/**
 * D10: the same canary, carried through the surfaces D7 and D8 added.
 *
 * The D1 test above proves the key is not written by the chat transport. That is not the
 * same claim as "no later slice writes it", and the later slices are exactly where a
 * credential ends up when nobody is looking: an approval row that stores the arguments it
 * was called with, a knowledge base that stores the text it embedded, an artifact whose
 * content came from a turn, and finally a directory that now holds a database, a corpus and
 * a secret beside each other.
 *
 * So this is one full flow — ingest, search, send, approve, save — and then a scan of every
 * table and every file. The flow's own outcomes are asserted first, because a flow that did
 * nothing would pass every absence check for the wrong reason.
 *
 * Every service here is the app's real one: the real `GenerationService`, the real
 * `KnowledgeService`, the real `McpManager` spawning `mock/mcp-echo-server.mjs`, and the
 * real repository layer over a real SQLite file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MOCK_SERVER = resolve(ROOT, "mock/server.mjs");
const ECHO_SERVER = resolve(ROOT, "mock/mcp-echo-server.mjs");

/** Deliberately free of the canary: the key must arrive by header, not in the document. */
const DOCUMENT = `# Solar array

The peak output of the inverter is 5.8 kilowatts at noon, measured on the south roof.
The battery bank holds twelve kilowatt hours. It charges from nine panels overnight.
`;

/** Every table in the v7 schema. A new table must be added here or it is unscanned. */
const TABLES = [
  "threads",
  "messages",
  "content_blocks",
  "generations",
  "settings",
  "attachments",
  "projects",
  "assistants",
  "prompts",
  "mcp_servers",
  "mcp_approvals",
  "documents",
  "chunks",
  "artifacts",
  "artifact_versions",
  "schema_migrations",
] as const;

type TableName = (typeof TABLES)[number];

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

async function waitForHealth(base: string, timeoutMs = 10_000): Promise<void> {
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

/**
 * A column's value as text, so a leak in a BLOB is as visible as a leak in a string.
 *
 * `JSON.stringify` on a Buffer emits `{"type":"Buffer","data":[115,107,…]}` — numbers, which
 * would never match a canary and would make the scan silently narrower than it claims. The
 * bytes are decoded instead, which is also how the file scan reads them.
 */
function columnText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("latin1");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("latin1");
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Which of these tables hold the canary anywhere in their rows. Named, so a failure says where. */
function tablesHolding(conn: Db, canary: string, tables: readonly TableName[]): TableName[] {
  return tables.filter((table) => {
    const rows = conn.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const text = rows.map((row) => Object.values(row).map(columnText).join("\n")).join("\n");
    return text.includes(canary);
  });
}

describe("secret redaction across the D7 and D8 surfaces", () => {
  const dirs: string[] = [];
  let mock: ChildProcess | undefined;
  let base = "";

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    mock = spawn(process.execPath, [MOCK_SERVER], {
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    });
    await waitForHealth(base);
  }, 30_000);

  afterEach(() => {
    closeDatabase();
  });

  afterAll(async () => {
    mock?.kill();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  /**
   * A turn, run to its terminal event. The ids come back from `send`; the answer arrives on
   * the bus, and a test that asserted before `done` would assert against a half-written row.
   */
  async function runTurn(
    service: GenerationService,
    request: ChatSendRequest,
  ): Promise<Awaited<ReturnType<GenerationService["send"]>>> {
    let settle: (event: GenerationEvent) => void = () => undefined;
    const terminal = new Promise<GenerationEvent>((resolveTerminal) => {
      settle = resolveTerminal;
    });

    const response = await service.send(request, (event) => {
      if (event.type === "done" || event.type === "error") settle(event);
    });

    const final = await terminal;
    if (final.type === "error") {
      throw new Error(`the turn failed: ${final.error.code} ${final.error.message}`);
    }
    return response;
  }

  it("keeps the key out of the knowledge store, the artifact, the approval and every file", async () => {
    // A real user-data directory: the secret, the database, the corpus copy and any
    // attachment would all live under this one path, which is what makes the final scan mean
    // something.
    const dir = await mkdtemp(join(tmpdir(), "cleon-redact-flow-"));
    dirs.push(dir);

    const secrets = new SecretsService(new ReversingBackend(), fileStore(dir));
    await secrets.setApiKey(CANARY);

    const conn = openDatabase(join(dir, "cleon.db"));
    const db: DrizzleDb = createDb(conn);

    const sourcePath = join(dir, "solar.md");
    await writeFile(sourcePath, DOCUMENT);

    /**
     * One resolver for all three services, exactly as `src/main/index.ts` wires it: the same
     * base URL and the same key reach the chat transport and the embedding endpoint.
     */
    const resolveConfig = async () => ({
      config: { baseUrl: base, apiKey: CANARY },
      model: "mock/embed",
    });
    const chatConfig = async () => ({ baseUrl: base, apiKey: CANARY });

    const knowledge = new KnowledgeService({
      db,
      rootDir: join(dir, "knowledge"),
      resolveConfig,
    });

    // 1. Ingest. The document's text leaves the machine for the embedding provider; the key
    //    goes with it as a header and must come back out of nothing that is stored.
    const documents = await knowledge.addDocuments([sourcePath]);
    expect(documents).toHaveLength(1);

    // 2. Search. The query text takes the same route.
    const hits = await knowledge.search({ query: "peak output of the inverter", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);

    // 3. Send. A real turn, through the real service, with retrieval in front of it.
    const turn = new GenerationService({
      db,
      bus: new GenerationBus(),
      resolveConfig: chatConfig,
      knowledge: { retrieve: (input) => knowledge.retrieve(input) },
    });

    const sent = await runTurn(turn, {
      threadId: null,
      text: "what is the peak output of the inverter?",
      model: "mock/text",
      useKnowledge: true,
    });

    // 4. Approve. The approval row is written with the arguments, then executed against a
    //    real child process.
    const mcp = new McpManager({ db, listTimeoutMs: 5_000, callTimeoutMs: 5_000 });
    try {
      const server = mcp.addServer({
        name: "echo",
        command: process.execPath,
        args: [ECHO_SERVER],
      });
      const { approvalId } = mcp.requestToolCall({
        serverId: server.id,
        tool: "echo",
        args: { text: "hello from the approval" },
      });
      const resolved = await mcp.resolveApproval({ approvalId, allow: true });
      expect(resolved.status).toBe("executed");
    } finally {
      mcp.dispose();
    }

    // 5. Attach a file. The attachment store is a second directory under the same root, and
    //    a second place a path or a credential could be written.
    const attachmentSource = join(dir, "notes.md");
    await writeFile(attachmentSource, "# notes\n\n5.8 kW at noon.\n");
    const attachments = createAttachmentHandlers({ db, rootDir: attachmentsRoot(dir) });
    const attached = await attachments["attachments.add"]({ paths: [attachmentSource] });
    expect(attached.attachments).toHaveLength(1);

    // 6. Save an artifact, twice, so the version history is written as well as the row.
    const first = saveArtifact(db, {
      artifactId: null,
      threadId: sent.threadId,
      title: "roof notes",
      content: "# roof notes\n\n5.8 kW at noon.",
    });
    saveArtifact(db, {
      artifactId: first.artifact.id,
      threadId: sent.threadId,
      title: "roof notes",
      content: "# roof notes\n\n5.8 kW at noon, derated above 45 °C.",
    });

    /**
     * The flow happened. Without these, every assertion below would pass on an empty
     * database, and a "no leaks" test over nothing is the most decorative test there is.
     */
    const tree = getThreadTree(db, sent.threadId);
    const answer = tree?.messages.find((message) => message.id === sent.assistantMessageId);
    expect(answer?.text).toBe("Hello from the mock.");
    expect(answer?.citations.length).toBeGreaterThan(0);

    const approval = conn
      .prepare("SELECT status, args_json FROM mcp_approvals WHERE server_id = ?")
      .get(
        (conn.prepare("SELECT id FROM mcp_servers LIMIT 1").get() as { id: string } | undefined)
          ?.id ?? "",
      ) as { status: string; args_json: string } | undefined;
    expect(approval?.status).toBe("executed");
    expect(approval?.args_json).toContain("hello from the approval");

    const versions = conn
      .prepare("SELECT count(*) AS n FROM artifact_versions WHERE artifact_id = ?")
      .get(first.artifact.id) as { n: number };
    expect(versions.n).toBe(2);

    // 6. The scan, requirement by requirement.

    // (a) MCP tool arguments persisted in `mcp_approvals`.
    expect(tablesHolding(conn, CANARY, ["mcp_approvals"])).toEqual([]);

    // (b) knowledge document text or chunk text — the whole row, which covers the title too.
    expect(tablesHolding(conn, CANARY, ["documents", "chunks"])).toEqual([]);

    // (c) artifact content.
    expect(tablesHolding(conn, CANARY, ["artifacts", "artifact_versions"])).toEqual([]);

    // The whole schema, so a surface added after this test is written is not silently
    // unscanned — the list is explicit above, and this catches the ones a future slice adds
    // to it by failing on the first run that populates them.
    expect(tablesHolding(conn, CANARY, TABLES)).toEqual([]);

    // (d) every file under the user-data directory, wherever it is nested.
    const files = await filesUnder(dir);
    const leaking = files.filter(([, contents]) => contents.includes(CANARY)).map(([name]) => name);
    expect(leaking).toEqual([]);

    // The scan is looking at the right directory: the ciphertext of the key is in it, and
    // the corpus copy is too. A scan of an empty directory would prove nothing.
    const secretFile = files.find(([name]) => name === "secret.bin");
    expect(secretFile?.[1]).toContain(new ReversingBackend().encrypt(CANARY));
    expect(files.some(([name]) => name.startsWith("knowledge/"))).toBe(true);
    expect(files.some(([name]) => name.startsWith("attachments/"))).toBe(true);
    expect(files.some(([name]) => name.startsWith("cleon.db"))).toBe(true);
  }, 60_000);
});

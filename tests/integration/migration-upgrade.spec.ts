import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase, schemaVersion } from "../../src/main/db/index.js";
import { MIGRATIONS } from "../../src/main/db/migrations.js";

/**
 * The upgrade path is the one thing a user with an existing database will hit and
 * a fresh-database test can never cover. It was proven by hand during D2; this is
 * that proof, committed — and extended at D10, when the schema reached v7 and the
 * oldest supported database was still a v1 from a release a month earlier.
 *
 * Every test below builds a database the way a *prior build* would have left it —
 * migrations 1..n applied with the checksums this build declares, plus the rows
 * that version could hold — and then opens it through the app's own opener. The
 * row assertions are conditional on the starting version because a v1 database
 * cannot contain an attachment: what is being proven is that nothing the version
 * *did* hold is lost, and that every table added since then arrives.
 */
const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex").slice(0, 32);

const LATEST = MIGRATIONS.at(-1)?.version ?? 0;

/** The ids every fixture reuses, so an assertion can name the row it means. */
const IDS = {
  thread: "11111111-1111-4111-8111-111111111111",
  userMessage: "22222222-2222-4222-8222-222222222222",
  assistantMessage: "33333333-3333-4333-8333-333333333333",
  settingsKey: "baseUrl",
  attachment: "44444444-4444-4444-8444-444444444444",
  project: "55555555-5555-4555-8555-555555555555",
  assistant: "66666666-6666-4666-8666-666666666666",
  prompt: "77777777-7777-4777-8777-777777777777",
  mcpServer: "88888888-8888-4888-8888-888888888888",
  approval: "99999999-9999-4999-8999-999999999999",
  document: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  chunk: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  artifact: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  artifactVersion: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;

function migrationAt(version: number) {
  const found = MIGRATIONS.find((migration) => migration.version === version);
  if (found === undefined) throw new Error(`migration ${version} is missing`);
  return found;
}

/**
 * A database as a user would have it at `version`.
 *
 * The migrations are applied in order with the checksums this build declares — the
 * same rows `openDatabase` would have written — so the upgrade under test starts
 * from a ledger the opener accepts rather than one it refuses for the wrong reason.
 *
 * The rows are the ones that version *could* hold. A v1 database has a thread and
 * two messages; a v4 one also has an attachment; a v6 one also has an MCP server
 * and an approval. Seeding a column the version does not have would make the fixture
 * a fiction, and the failure would be in the fixture rather than the upgrade.
 */
async function buildDatabaseAt(path: string, version: number): Promise<void> {
  const conn = new Database(path);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const insertLedger = conn.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)",
  );
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    conn.exec(migration.sql);
    insertLedger.run(
      migration.version,
      migration.name,
      checksum(migration.sql),
      new Date().toISOString(),
    );
  }

  // Present at every version: one thread and two messages. The text is what the FTS
  // index stores, so a surviving `MATCH` is proof the index took part in the upgrade.
  conn.prepare("INSERT INTO threads (id, title) VALUES (?, ?)").run(IDS.thread, "legacy thread");
  conn
    .prepare("INSERT INTO messages (id, thread_id, role, text) VALUES (?, ?, ?, ?)")
    .run(IDS.userMessage, IDS.thread, "user", "legacy otters");
  conn
    .prepare("INSERT INTO messages (id, thread_id, parent_id, role, text) VALUES (?, ?, ?, ?, ?)")
    .run(IDS.assistantMessage, IDS.thread, IDS.userMessage, "assistant", "the otter answers");

  if (version >= 2) {
    // A user who picked a variant before upgrading: the pointer must survive with its value.
    conn
      .prepare("UPDATE threads SET active_leaf_id = ? WHERE id = ?")
      .run(IDS.assistantMessage, IDS.thread);
  }

  if (version >= 3) {
    conn
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(IDS.settingsKey, "http://127.0.0.1:4790");
  }

  if (version >= 4) {
    conn
      .prepare(
        "INSERT INTO attachments (id, thread_id, message_id, filename, mime, size_bytes, kind, stored_path) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        IDS.attachment,
        IDS.thread,
        IDS.userMessage,
        "notes.md",
        "text/markdown",
        12,
        "document",
        "/tmp/notes.md",
      );
  }

  if (version >= 5) {
    conn
      .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
      .run(IDS.project, "legacy project");
    conn
      .prepare("INSERT INTO assistants (id, name, model, system_prompt) VALUES (?, ?, ?, ?)")
      .run(IDS.assistant, "legacy assistant", "mock/text", "be brief");
    conn
      .prepare("INSERT INTO prompts (id, title, body) VALUES (?, ?, ?)")
      .run(IDS.prompt, "legacy prompt", "summarise {{selection}}");
    conn
      .prepare("UPDATE threads SET project_id = ?, assistant_id = ? WHERE id = ?")
      .run(IDS.project, IDS.assistant, IDS.thread);
  }

  if (version >= 6) {
    conn
      .prepare("INSERT INTO mcp_servers (id, name, command, args_json) VALUES (?, ?, ?, ?)")
      .run(IDS.mcpServer, "legacy server", "node", '["mock/mcp-echo-server.mjs"]');
    conn
      .prepare(
        "INSERT INTO mcp_approvals (id, server_id, tool, args_json, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run(IDS.approval, IDS.mcpServer, "echo", '{"text":"legacy"}', "executed");
  }

  if (version >= 7) {
    conn
      .prepare(
        "INSERT INTO documents (id, title, source_path, mime, bytes, chunk_count) VALUES (?,?,?,?,?,?)",
      )
      .run(IDS.document, "solar.md", "/tmp/solar.md", "text/markdown", 32, 1);
    conn
      .prepare(
        "INSERT INTO chunks (id, document_id, ordinal, text, embedding, dim) VALUES (?,?,?,?,?,?)",
      )
      .run(IDS.chunk, IDS.document, 0, "peak output of the inverter", Buffer.alloc(4), 1);
    conn
      .prepare("INSERT INTO artifacts (id, thread_id, title) VALUES (?, ?, ?)")
      .run(IDS.artifact, IDS.thread, "legacy artifact");
    conn
      .prepare("INSERT INTO artifact_versions (id, artifact_id, version, content) VALUES (?,?,?,?)")
      .run(IDS.artifactVersion, IDS.artifact, 1, "# legacy");
    conn
      .prepare("UPDATE messages SET citations_json = ? WHERE id = ?")
      .run(
        JSON.stringify([
          { chunkId: IDS.chunk, documentId: IDS.document, documentTitle: "solar.md", ordinal: 0 },
        ]),
        IDS.assistantMessage,
      );
  }

  conn.close();
}

function maxVersion(path: string): number {
  const raw = new Database(path, { readonly: true });
  const row = raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
    v: number | null;
  };
  raw.close();
  return row.v ?? 0;
}

function tableNames(conn: Db): string[] {
  return (
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function columnNames(conn: Db, table: string): string[] {
  return (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

/**
 * The assertions every upgrade must satisfy, whichever version it started from.
 *
 * Split from the per-version rows on purpose: "the schema reached v7" and "the rows
 * this database had are still readable" are two claims, and a single assertion block
 * that mixes them hides which one broke.
 */
function assertUpgradedToLatest(conn: Db): void {
  // Derived, not hardcoded: every new migration must not require editing this test.
  expect(LATEST).toBeGreaterThanOrEqual(7);
  expect(schemaVersion(conn)).toBe(LATEST);

  // The ledger is complete: every migration, in order, with the checksum this build
  // declares. A ledger that merely "reached 7" could have skipped a name or recorded a
  // checksum the opener would refuse on the next launch.
  const ledger = conn
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as { version: number; name: string; checksum: string }[];
  expect(ledger).toEqual(
    MIGRATIONS.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: checksum(migration.sql),
    })),
  );

  // Every table the later slices added is present, including the two that had to be
  // built on top of a legacy `messages` table.
  const tables = tableNames(conn);
  for (const table of [
    "attachments",
    "settings",
    "projects",
    "assistants",
    "prompts",
    "mcp_servers",
    "mcp_approvals",
    "documents",
    "chunks",
    "artifacts",
    "artifact_versions",
  ]) {
    expect(tables).toContain(table);
  }

  // `ALTER TABLE … ADD COLUMN` runs against a legacy table, which is the one kind of
  // change an existing database can reject — so the columns are asserted, not assumed.
  expect(columnNames(conn, "threads")).toContain("active_leaf_id");
  expect(columnNames(conn, "threads")).toContain("assistant_id");
  expect(columnNames(conn, "messages")).toContain("citations_json");

  // The v1 rows survive their title and their text.
  const thread = conn.prepare("SELECT title FROM threads WHERE id = ?").get(IDS.thread) as
    | { title: string }
    | undefined;
  expect(thread?.title).toBe("legacy thread");

  const texts = conn
    .prepare("SELECT id, text FROM messages WHERE thread_id = ? ORDER BY created_at, rowid")
    .all(IDS.thread) as { id: string; text: string }[];
  expect(texts).toEqual([
    { id: IDS.userMessage, text: "legacy otters" },
    { id: IDS.assistantMessage, text: "the otter answers" },
  ]);

  // The FTS index that existed before the upgrade still answers.
  const hit = conn
    .prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?")
    .all("otters") as { message_id: string }[];
  expect(hit.map((row) => row.message_id)).toEqual([IDS.userMessage]);
}

/** The rows a database at `from` was holding, asserted after it became live. */
function assertRowsIntact(conn: Db, from: number): void {
  const thread = conn
    .prepare("SELECT active_leaf_id, project_id, assistant_id FROM threads WHERE id = ?")
    .get(IDS.thread) as
    | { active_leaf_id: string | null; project_id: string | null; assistant_id: string | null }
    | undefined;

  // v2's pointer: null at v1 (the column did not exist), the chosen leaf at v2+.
  expect(thread?.active_leaf_id).toBe(from >= 2 ? IDS.assistantMessage : null);

  // v3's settings.
  if (from >= 3) {
    const setting = conn.prepare("SELECT value FROM settings WHERE key = ?").get(IDS.settingsKey) as
      | { value: string }
      | undefined;
    expect(setting?.value).toBe("http://127.0.0.1:4790");
  }

  // v4's attachment, with its message link intact.
  if (from >= 4) {
    const attachment = conn
      .prepare("SELECT filename, message_id FROM attachments WHERE id = ?")
      .get(IDS.attachment) as { filename: string; message_id: string } | undefined;
    expect(attachment).toEqual({ filename: "notes.md", message_id: IDS.userMessage });
  }

  // v5's project, assistant and prompt, and the two thread pointers.
  if (from >= 5) {
    expect(thread).toMatchObject({ project_id: IDS.project, assistant_id: IDS.assistant });
    const assistant = conn
      .prepare("SELECT model, system_prompt FROM assistants WHERE id = ?")
      .get(IDS.assistant) as { model: string; system_prompt: string } | undefined;
    expect(assistant).toEqual({ model: "mock/text", system_prompt: "be brief" });
    const prompt = conn.prepare("SELECT title FROM prompts WHERE id = ?").get(IDS.prompt) as
      | { title: string }
      | undefined;
    expect(prompt?.title).toBe("legacy prompt");
  }

  // v6's server and its approval record, arguments included — the row the panel reads back.
  if (from >= 6) {
    const approval = conn
      .prepare("SELECT tool, args_json, status FROM mcp_approvals WHERE id = ?")
      .get(IDS.approval) as { tool: string; args_json: string; status: string } | undefined;
    expect(approval).toEqual({ tool: "echo", args_json: '{"text":"legacy"}', status: "executed" });
    const server = conn
      .prepare("SELECT command, args_json FROM mcp_servers WHERE id = ?")
      .get(IDS.mcpServer) as { command: string; args_json: string } | undefined;
    expect(server).toEqual({ command: "node", args_json: '["mock/mcp-echo-server.mjs"]' });
  }

  // v7's corpus, artifact and citation list.
  if (from >= 7) {
    const chunk = conn.prepare("SELECT text, dim FROM chunks WHERE id = ?").get(IDS.chunk) as
      | { text: string; dim: number }
      | undefined;
    expect(chunk).toEqual({ text: "peak output of the inverter", dim: 1 });
    const version = conn
      .prepare("SELECT content FROM artifact_versions WHERE id = ?")
      .get(IDS.artifactVersion) as { content: string } | undefined;
    expect(version?.content).toBe("# legacy");
    const citations = conn
      .prepare("SELECT citations_json FROM messages WHERE id = ?")
      .get(IDS.assistantMessage) as { citations_json: string | null } | undefined;
    expect(citations?.citations_json ?? "").toContain(IDS.chunk);
  }
}

describe("migration upgrade", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    closeDatabase();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  // The opener is a module-level singleton; two tests opening two databases in one
  // process would otherwise share whichever connection was built first.
  afterEach(() => {
    closeDatabase();
  });

  async function fixture(version: number): Promise<{ path: string; conn: Db }> {
    const dir = await mkdtemp(join(tmpdir(), "cleon-migrate-"));
    dirs.push(dir);
    const path = join(dir, "cleon.db");

    await buildDatabaseAt(path, version);

    // Sanity: the fixture really is at `version` before the app's opener touches it.
    expect(maxVersion(path)).toBe(version);

    return { path, conn: openDatabase(path) };
  }

  it("upgrades a real v1 database to the latest schema without losing data or the FTS index", async () => {
    const { conn } = await fixture(1);

    assertUpgradedToLatest(conn);
    assertRowsIntact(conn, 1);

    // A v1 database has no attachment to keep, and the table that will hold one arrives empty.
    const attachments = conn.prepare("SELECT count(*) AS n FROM attachments").get() as {
      n: number;
    };
    expect(attachments.n).toBe(0);
  });

  it("upgrades a v3 database (pre-attachments) to the latest schema with its rows intact", async () => {
    const { conn } = await fixture(3);

    assertUpgradedToLatest(conn);
    assertRowsIntact(conn, 3);

    // The tables v4 and later introduce arrive empty rather than half-populated: a v3
    // database never had an attachment row, and an upgrade must not invent one.
    for (const table of ["attachments", "documents", "chunks", "artifacts", "mcp_servers"]) {
      const count = conn.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      expect(count.n).toBe(0);
    }

    // The settings row v3 introduced answers a plain query, which is what `settings.get` does.
    const settings = conn.prepare("SELECT key, value FROM settings ORDER BY key").all() as {
      key: string;
      value: string;
    }[];
    expect(settings).toEqual([{ key: "baseUrl", value: "http://127.0.0.1:4790" }]);
  });

  /**
   * The headline: every version a released build could have left behind, not just v1 — plus
   * the current one, where the opener must be a no-op rather than a second apply.
   */
  it.each([
    1, 2, 3, 4, 5, 6, 7,
  ])("opens a v%i database at the latest schema, keeping that version's rows", async (from) => {
    const { conn } = await fixture(from);

    assertUpgradedToLatest(conn);
    assertRowsIntact(conn, from);
  });

  it("refuses to open a database whose applied migration was edited", async () => {
    const { path } = await fixture(1);
    closeDatabase();

    // Simulate drift: someone edited migration 1 after it was applied.
    const raw = new Database(path);
    raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("deadbeef");
    raw.close();

    expect(() => openDatabase(path)).toThrow(/checksum mismatch/i);
  });

  it("refuses drift in a mid-chain migration, not only the first one", async () => {
    const { path } = await fixture(3);
    closeDatabase();

    // v2 is applied but no longer matches this build: the v1 checksum still agrees, so a
    // check that only looked at the first row would open this database happily.
    const raw = new Database(path);
    raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 2").run("deadbeef");
    raw.close();

    expect(() => openDatabase(path)).toThrow(
      /migration 2 \(thread-active-leaf\) checksum mismatch/i,
    );
  });

  it("has a ledger entry for every migration it declares, with no gaps", () => {
    // A gap would mean a version number was reused or a migration removed after release.
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 1));
    expect(migrationAt(1).name).toBe("init");
  });
});

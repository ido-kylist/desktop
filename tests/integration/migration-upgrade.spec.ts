import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, schemaVersion } from "../../src/main/db/index.js";
import { MIGRATIONS } from "../../src/main/db/migrations.js";

/**
 * The upgrade path is the one thing a user with an existing database will hit and
 * a fresh-database test can never cover. It was proven by hand during D2; this is
 * that proof, committed.
 */
const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex").slice(0, 32);

async function buildV1Database(path: string): Promise<void> {
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

  const first = MIGRATIONS[0];
  if (!first) throw new Error("migration 1 missing");

  conn.exec(first.sql);
  conn
    .prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)")
    .run(first.version, first.name, checksum(first.sql), new Date().toISOString());

  // Legacy data that must survive the upgrade, including text the FTS trigger indexes.
  conn
    .prepare("INSERT INTO threads (id, title) VALUES (?, ?)")
    .run("11111111-1111-4111-8111-111111111111", "legacy thread");
  conn
    .prepare("INSERT INTO messages (id, thread_id, role, text) VALUES (?, ?, ?, ?)")
    .run(
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      "user",
      "legacy otters",
    );

  conn.close();
}

describe("migration upgrade", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    closeDatabase();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it("upgrades a real v1 database to the latest schema without losing data or the FTS index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleon-migrate-"));
    dirs.push(dir);
    const path = join(dir, "cleon.db");

    await buildV1Database(path);

    // Sanity: the fixture really is v1 before we open it through the app's opener.
    const raw = new Database(path, { readonly: true });
    const before = raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number;
    };
    expect(before.v).toBe(1);
    raw.close();

    const conn = openDatabase(path);

    // Derived, not hardcoded: every new migration must not require editing this test.
    const latest = MIGRATIONS.at(-1)?.version;
    expect(latest).toBeDefined();
    expect(schemaVersion(conn)).toBe(latest);

    const columns = conn.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("active_leaf_id");

    // Migration 7's `ALTER TABLE messages ADD COLUMN` runs against a legacy table, which is
    // the one kind of change an existing database can reject. The new tables come with it.
    const messageColumns = (
      conn.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(messageColumns).toContain("citations_json");
    const tables = (
      conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    for (const table of ["documents", "chunks", "artifacts", "artifact_versions"]) {
      expect(tables).toContain(table);
    }

    const thread = conn
      .prepare("SELECT title, active_leaf_id FROM threads WHERE id = ?")
      .get("11111111-1111-4111-8111-111111111111") as {
      title: string;
      active_leaf_id: string | null;
    };
    expect(thread.title).toBe("legacy thread");
    expect(thread.active_leaf_id).toBeNull();

    // The FTS index that existed before the upgrade still answers.
    const hit = conn
      .prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?")
      .all("otters") as { message_id: string }[];
    expect(hit.map((r) => r.message_id)).toEqual(["22222222-2222-4222-8222-222222222222"]);

    // The ledger records every migration, in order, with the declared names.
    const ledger = conn
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];
    expect(ledger).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
  });

  it("refuses to open a database whose applied migration was edited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleon-migrate-"));
    dirs.push(dir);
    const path = join(dir, "cleon.db");

    await buildV1Database(path);

    // Simulate drift: someone edited migration 1 after it was applied.
    const raw = new Database(path);
    raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("deadbeef");
    raw.close();

    closeDatabase();
    expect(() => openDatabase(path)).toThrow(/checksum mismatch/i);
  });
});

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export type Db = Database.Database;

let db: Db | null = null;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 32);
}

/**
 * Opens the database, applies pending migrations, and refuses to run against a
 * migration whose checksum has changed. WAL because a chat app reads while it writes.
 */
export function openDatabase(filePath: string): Db {
  if (db) return db;

  mkdirSync(dirname(filePath), { recursive: true });
  const conn = new Database(filePath);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("busy_timeout = 5000");

  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Map<number, { checksum: string; name: string }>(
    conn
      .prepare("SELECT version, checksum, name FROM schema_migrations")
      .all()
      .map((row) => {
        const r = row as { version: number; checksum: string; name: string };
        return [r.version, { checksum: r.checksum, name: r.name }];
      }),
  );

  for (const migration of MIGRATIONS) {
    const sum = checksum(migration.sql);
    const prior = applied.get(migration.version);

    if (prior) {
      if (prior.checksum !== sum) {
        throw new Error(
          `migration ${migration.version} (${migration.name}) checksum mismatch: ` +
            `applied ${prior.checksum}, found ${sum}`,
        );
      }
      continue;
    }

    const apply = conn.transaction(() => {
      conn.exec(migration.sql);
      conn
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, sum, new Date().toISOString());
    });
    apply();
  }

  db = conn;
  return conn;
}

export function schemaVersion(conn: Db): number {
  const row = conn.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

export function hasFts5(conn: Db): boolean {
  try {
    conn.prepare("SELECT count(*) FROM messages_fts").get();
    return true;
  } catch {
    return false;
  }
}

export function countRows(conn: Db, table: "threads" | "messages"): number {
  const row = conn.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Default on-disk location, injected by the main process. */
export function defaultDbPath(userDataDir: string): string {
  const path = join(userDataDir, "cleon.db");
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

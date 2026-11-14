import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "./index.js";

/**
 * Drizzle over the connection `openDatabase` already owns.
 *
 * The connection is *given*, never created here: pragmas, the migration ledger
 * and the FTS5 virtual table are all established by `db/index.ts`, and a second
 * `new Database(...)` would be a second writer to the same file. Drizzle is a
 * query builder over the handle, not a second connection.
 *
 * No schema argument. The typed table objects in `schema.ts` are already bound to
 * the query builder through their own column types, and nothing here uses
 * drizzle's relational query API — so passing the schema would only widen types
 * for no benefit.
 */
export type DrizzleDb = BetterSQLite3Database<Record<string, never>>;

export function createDb(conn: Db): DrizzleDb {
  return drizzle(conn);
}

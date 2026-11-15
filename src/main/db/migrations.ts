/**
 * Migrations are the single source of truth. They are inline so the packaged app
 * carries them without an asset-resolution step, and each one is checksummed at
 * apply time — a mutated migration is a hard failure, not a silent divergence.
 *
 * FTS5 is hand-written rather than generated: drizzle-kit cannot express a virtual
 * table or its triggers, and pretending otherwise hides the part that matters.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'New thread',
  project_id  TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS threads_updated_idx ON threads (updated_at DESC);
CREATE INDEX IF NOT EXISTS threads_project_idx ON threads (project_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  parent_id  TEXT,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  text       TEXT NOT NULL DEFAULT '',
  model      TEXT,
  variant_of TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS messages_parent_idx ON messages (parent_id);

CREATE TABLE IF NOT EXISTS content_blocks (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('text','reasoning','image','document','tool_call','tool_result')),
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_message_idx ON content_blocks (message_id, ordinal);

CREATE TABLE IF NOT EXISTS generations (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  message_id        TEXT REFERENCES messages (id) ON DELETE SET NULL,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_microcents   INTEGER NOT NULL DEFAULT 0,
  finish_reason     TEXT,
  error_code        TEXT,
  started_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at          TEXT
);
CREATE INDEX IF NOT EXISTS generations_thread_idx ON generations (thread_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (message_id, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts (message_id, text) VALUES (new.id, new.text);
END;
`.trim(),
  },
  {
    /**
     * Which variant of a branched thread is on screen.
     *
     * Nullable on purpose: null means "follow the newest leaf", which is what every
     * thread written before D3 does and what an unbranched thread keeps doing. A
     * non-null id is a message the user explicitly selected with
     * `chat.setActiveVariant`, and it is the leaf the next turn hangs under.
     *
     * No foreign key: the column is a hint, not an authority. A leaf that was
     * soft-deleted or never belonged to the thread is ignored by the read, which
     * falls back to the newest leaf rather than failing a whole conversation over
     * a stale pointer.
     */
    version: 2,
    name: "thread-active-leaf",
    sql: "ALTER TABLE threads ADD COLUMN active_leaf_id TEXT;",
  },
  {
    version: 3,
    name: "settings",
    sql: `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`.trim(),
  },
];

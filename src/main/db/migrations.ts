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
  {
    version: 4,
    name: "attachments",
    sql: `
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT REFERENCES threads (id) ON DELETE CASCADE,
  message_id  TEXT REFERENCES messages (id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('image','document')),
  stored_path TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments (message_id);
CREATE INDEX IF NOT EXISTS attachments_thread_idx ON attachments (thread_id);
`.trim(),
  },
  {
    /**
     * D6: projects, assistants, prompts — and the two columns on `threads` that make
     * them mean something.
     *
     * `threads.project_id` has existed since migration 1 and already carries its index
     * (`threads_project_idx`); what was missing was the table it points at. The index on
     * `threads.assistant_id` is new, because that column is.
     *
     * No foreign keys on the two new thread columns, for the same reason
     * `active_leaf_id` has none: both are hints for the next turn, and a project or
     * assistant archived while a thread still names it must not make the thread
     * unreadable. Deleting an assistant archives it, and a project is never deleted.
     *
     * `temperature` is REAL. SQLite's dynamic typing would accept a string here, so the
     * contract's `z.number().min(0).max(2)` and the Drizzle column type are what keep it
     * honest.
     */
    version: 5,
    name: "projects-assistants-prompts",
    sql: `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS assistants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  model         TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  temperature   REAL NOT NULL DEFAULT 0.7,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at   TEXT
);
CREATE INDEX IF NOT EXISTS assistants_updated_idx ON assistants (updated_at DESC);

CREATE TABLE IF NOT EXISTS prompts (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS prompts_updated_idx ON prompts (updated_at DESC);

ALTER TABLE threads ADD COLUMN assistant_id TEXT;
CREATE INDEX IF NOT EXISTS threads_assistant_idx ON threads (assistant_id);
`.trim(),
  },
  {
    /**
     * D7: local MCP servers, and the approval record that gates every tool call.
     *
     * `args_json` and `env_json` are JSON text rather than child tables: an argument list
     * is an ordered vector, not a set of rows, and nothing ever queries *into* it. They
     * are read whole and passed to `spawn` unchanged.
     *
     * `env_json` exists so a server can be given environment of its own later without a
     * second migration. Nothing writes it in this phase — `mcp.addServer` takes no env —
     * so it defaults to `{}` and the child inherits the app's environment.
     *
     * `enabled` is likewise stored, defaulted to 1, and not yet exposed: it is the column a
     * "disable without removing" affordance needs, and adding it later would be a
     * migration for a boolean.
     *
     * The approval table is the security record. `status` is checked against the closed set
     * the contract declares, so a row written by a newer build cannot present an older
     * renderer with a state it has no picture for. `resolved_at` is null exactly while
     * `status = 'pending'`; the repository enforces that pairing (the conditional UPDATE
     * sets both together) because SQLite's CHECK cannot reference the row's transition.
     *
     * `ON DELETE CASCADE` on `server_id`: removing a server removes its approvals. The
     * alternative — a durable audit that outlives the thing it audits — needs a
     * denormalised server name to stay readable, and that is a design change, not a
     * constraint. It is recorded in BACKLOG.md.
     */
    version: 6,
    name: "mcp-servers",
    sql: `
CREATE TABLE IF NOT EXISTS mcp_servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  command    TEXT NOT NULL,
  args_json  TEXT NOT NULL DEFAULT '[]',
  env_json   TEXT NOT NULL DEFAULT '{}',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS mcp_servers_created_idx ON mcp_servers (created_at);

CREATE TABLE IF NOT EXISTS mcp_approvals (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  tool        TEXT NOT NULL,
  args_json   TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL CHECK (status IN ('pending','executed','denied','failed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS mcp_approvals_server_idx ON mcp_approvals (server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_approvals_status_idx ON mcp_approvals (status);
`.trim(),
  },
  {
    /**
     * D8: the knowledge base and versioned artifacts.
     *
     * `chunks.embedding` is a BLOB of little-endian float32s, and `dim` is stored beside it
     * rather than derived from the blob's length. Two reasons: a zero-length blob must not
     * read as a zero-dimension vector, and a chunk indexed by one embedding model must be
     * recognisable as incomparable with a query embedded by another. Search filters on
     * `dim` and says so when nothing matches, instead of silently returning nothing.
     *
     * `chunks.document_id` cascades: a chunk without its document is unreachable, and
     * deleting a document that left its vectors behind would leak both disk and results.
     * `UNIQUE (document_id, ordinal)` is the chunking contract made durable — one ordinal
     * appears once, so a re-index of a document cannot half-overwrite it.
     *
     * `documents.source_path` has a unique index: the same file indexed twice is the same
     * text and a second bill from the embedding provider. `kb.addDocument` reports the
     * existing document as CONFLICT rather than writing the duplicate.
     *
     * `artifacts.thread_id` cascades off `threads`. Threads are soft-deleted in this app, so
     * the cascade only fires if a thread row is ever really removed — but an artifact whose
     * owner is gone has nowhere to be shown.
     *
     * `artifact_versions` is append-only by construction: nothing in the codebase updates or
     * deletes a version row, and `UNIQUE (artifact_id, version)` plus the conditional bump of
     * `artifacts.current_version` are what keep the sequence contiguous under a retry.
     *
     * `messages.citations_json` is the citation list, written once when the assistant row is
     * created. It is JSON text rather than a join table because it is a value of the message,
     * read whole with it and never queried into — the same trade `mcp_servers.args_json` makes.
     */
    version: 7,
    name: "knowledge-artifacts",
    sql: `
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  source_path TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS documents_source_idx ON documents (source_path);
CREATE INDEX IF NOT EXISTS documents_created_idx ON documents (created_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  embedding   BLOB NOT NULL,
  dim         INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id, ordinal);
CREATE INDEX IF NOT EXISTS chunks_dim_idx ON chunks (dim);

CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS artifacts_thread_idx ON artifacts (thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (artifact_id, version)
);
CREATE INDEX IF NOT EXISTS artifact_versions_artifact_idx ON artifact_versions (artifact_id, version);

ALTER TABLE messages ADD COLUMN citations_json TEXT;
`.trim(),
  },
];

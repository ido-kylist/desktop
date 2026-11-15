#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile, loadDbLayer } from "./compile.mjs";

/**
 * Seeds a throwaway database with 500 threads × 10 messages, for the perf harness.
 *
 *   node scripts/perf/seed.mjs                       # temp dir, prints the path
 *   node scripts/perf/seed.mjs --user-data <dir>      # <dir>/cleon.db, for the app
 *   node scripts/perf/seed.mjs --db <file> --threads 40 --messages 6
 *
 * The rows go in through the repo layer (`createThread` / `insertMessage` / `touchThread`),
 * so the FTS5 triggers fire exactly as they do in the app and the search benchmark measures
 * the index the app would have. Inserting with raw SQL would be faster and would prove
 * nothing about the schema.
 *
 * Two properties of the data are deliberate, because the measurements depend on them:
 *
 *  - **Half the threads are findable by one term.** Even-indexed threads carry the word
 *    `heron` in every message, so `threads.list` with `query: "heron"` matches 250 of 500
 *    threads and does real work: BM25 over 2 500 rows, `snippet()` over the same, and one
 *    row per thread chosen with `ROW_NUMBER()`.
 *  - **Every thread has the same shape.** Ten messages, alternating user/assistant, each
 *    with `parent_id` set so the tree read has a path to walk. A uniform corpus is what
 *    makes p50/p95 comparable between runs.
 */

const DEFAULTS = { threads: 500, messages: 10 };

function parseArgs(argv) {
  const options = { ...DEFAULTS, db: null, userData: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--db") {
      options.db = value;
      index += 1;
    } else if (flag === "--user-data") {
      options.userData = value;
      index += 1;
    } else if (flag === "--threads") {
      options.threads = Number(value);
      index += 1;
    } else if (flag === "--messages") {
      options.messages = Number(value);
      index += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log("see the header of scripts/perf/seed.mjs");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!Number.isInteger(options.threads) || options.threads <= 0) {
    throw new Error("--threads must be a positive integer");
  }
  if (!Number.isInteger(options.messages) || options.messages <= 0) {
    throw new Error("--messages must be a positive integer");
  }
  return options;
}

/** The sentence a seeded turn carries. Stable so a diff between two runs means a change. */
function textFor(threadIndex, messageIndex) {
  const topic = threadIndex % 2 === 0 ? "heron" : "otter";
  return (
    `Thread ${threadIndex} message ${messageIndex}: a note about the ${topic} ` +
    `and the river it was seen beside, written to be long enough that the snippet ` +
    `window has something to cut.`
  );
}

export async function seed({ threads = DEFAULTS.threads, messages = DEFAULTS.messages, dbPath }) {
  compile({ skipIfPresent: true });
  const layer = await loadDbLayer();

  const conn = layer.openDatabase(dbPath);
  const db = layer.createDb(conn);

  if (layer.hasFts5(conn) !== true) throw new Error("FTS5 is unavailable in this SQLite build");

  const threadIds = [];
  const startedAt = Date.now();

  const insertAll = conn.transaction(() => {
    for (let threadIndex = 0; threadIndex < threads; threadIndex += 1) {
      const threadId = randomUUID();
      threadIds.push(threadId);
      layer.createThread(db, {
        id: threadId,
        title: `Thread ${threadIndex} about the ${threadIndex % 2 === 0 ? "heron" : "otter"}`,
      });

      let parentId = null;
      for (let messageIndex = 0; messageIndex < messages; messageIndex += 1) {
        const messageId = randomUUID();
        layer.insertMessage(db, {
          id: messageId,
          threadId,
          parentId,
          role: messageIndex % 2 === 0 ? "user" : "assistant",
          text: textFor(threadIndex, messageIndex),
          model: "perf/seed",
        });
        parentId = messageId;
      }
      layer.touchThread(db, threadId);
    }
  });
  insertAll();

  const threadCount = conn.prepare("SELECT COUNT(*) AS n FROM threads").get().n;
  const messageCount = conn.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  const ftsCount = conn.prepare("SELECT COUNT(*) AS n FROM messages_fts").get().n;

  return {
    dbPath,
    threads: threadCount,
    messages: messageCount,
    ftsRows: ftsCount,
    schemaVersion: layer.schemaVersion(conn),
    seedMs: Date.now() - startedAt,
    threadIds,
    close: () => conn.close(),
  };
}

/* ------------------------------------------------------------------- CLI */

function isMain() {
  return process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
}

if (isMain()) {
  const options = parseArgs(process.argv.slice(2));

  let dbPath = options.db;
  if (dbPath === null) {
    // A directory was named (or nothing was): the database lives inside it, exactly where
    // the app would put it, so `--user-data` can be handed straight to a launch.
    const directory = options.userData ?? mkdtempSync(join(tmpdir(), "cleon-perf-"));
    dbPath = join(directory, "cleon.db");
    if (options.userData === null) {
      console.error(`temp directory kept for inspection: ${directory}`);
      console.error(`launch the app against it with CLEON_USER_DATA=${directory}`);
    }
  }
  mkdirSync(dirname(dbPath), { recursive: true });

  const result = await seed({ threads: options.threads, messages: options.messages, dbPath });
  result.close();

  console.log(
    JSON.stringify(
      {
        dbPath: result.dbPath,
        threads: result.threads,
        messages: result.messages,
        ftsRows: result.ftsRows,
        schemaVersion: result.schemaVersion,
        seedMs: result.seedMs,
      },
      null,
      2,
    ),
  );
}

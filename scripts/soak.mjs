#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The D10 soak: sequential turns through the app's own generation path, against the mock.
 *
 *   node scripts/soak.mjs                          # 200 turns, or 30 minutes, whichever first
 *   node scripts/soak.mjs --messages 50            # a shorter run
 *   node scripts/soak.mjs --minutes 5 --out r.json
 *
 * What it drives is `GenerationService.send` — the same orchestrator `chat.send` calls in
 * the packaged app: the same SQLite writes, the same 250 ms checkpoints, the same SSE
 * parser, the same `GenerationBus`. Nothing is stubbed. The only substitution is the
 * provider, which is `mock/server.mjs` streaming one frame at a time with a real delay
 * between frames, so the deltas arrive as deltas rather than as one buffered response.
 *
 * What it records, per turn and in total:
 *
 *   - wall time per turn, delta count, characters streamed
 *   - RSS / heap after every turn, so "does it grow" is a series rather than a memory
 *   - bus listeners still attached to the finished generation (must be zero: the service
 *     releases its subscription on the terminal event, and a leak there is a leak per turn)
 *   - process-level listener counts and active-resource count, before and after
 *   - the message count in SQLite at the end
 *   - whether the bound hit was the message count or the clock, and any crash
 *
 * It compiles the TypeScript it needs with tsc first, for the same reason `scripts/perf`
 * does: plain `node` cannot import a module that addresses its neighbours as `./x.js`.
 * The compiled copy is the repo's own code, not a re-implementation.
 */

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPTS_DIR, "..");
const BUILD = join(SCRIPTS_DIR, "soak", ".build");
const MOCK_SERVER = resolve(ROOT, "mock/server.mjs");

const DEFAULTS = {
  messages: 200,
  minutes: 30,
  frameDelayMs: 25,
  threadTurns: Number.POSITIVE_INFINITY,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, out: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--messages") {
      options.messages = Number(value);
      index += 1;
    } else if (flag === "--minutes") {
      options.minutes = Number(value);
      index += 1;
    } else if (flag === "--frame-delay") {
      options.frameDelayMs = Number(value);
      index += 1;
    } else if (flag === "--thread-turns") {
      options.threadTurns = Number(value);
      index += 1;
    } else if (flag === "--out") {
      options.out = value;
      index += 1;
    } else if (flag === "--keep") {
      options.keep = true;
    } else if (flag === "--help" || flag === "-h") {
      console.log(
        "usage: node scripts/soak.mjs [--messages 200] [--minutes 30] [--frame-delay 25] [--thread-turns N] [--out file.json] [--keep]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  for (const key of ["messages", "minutes", "frameDelayMs"]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`--${key} must be a positive number`);
    }
  }
  if (Number.isNaN(options.threadTurns) || options.threadTurns <= 0) {
    throw new Error("--thread-turns must be a positive number");
  }
  return options;
}

function compile() {
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules/typescript/bin/tsc"),
      "-p",
      join(SCRIPTS_DIR, "soak", "tsconfig.json"),
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`soak: compiling the generation path failed (exit ${result.status})`);
  }
}

async function load() {
  const loadOne = (relative) => import(pathToFileURL(join(BUILD, relative)).href);
  const [generations, bus, dbIndex, client] = await Promise.all([
    loadOne("src/main/api/generations.js"),
    loadOne("src/main/api/bus.js"),
    loadOne("src/main/db/index.js"),
    loadOne("src/main/db/client.js"),
  ]);
  return {
    GenerationService: generations.GenerationService,
    GenerationBus: bus.GenerationBus,
    openDatabase: dbIndex.openDatabase,
    countRows: dbIndex.countRows,
    createDb: client.createDb,
  };
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
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

async function waitForHealth(base, timeoutMs = 10_000) {
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

const MB = 1024 * 1024;

function round(value, places = 2) {
  return Number(value.toFixed(places));
}

/** Least-squares slope of y over x, in the y units per x unit. */
function slope(points) {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((total, point) => total + point[0], 0) / n;
  const meanY = points.reduce((total, point) => total + point[1], 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function processShape() {
  return {
    listeners: Object.fromEntries(
      process
        .eventNames()
        .map((name) => [String(name), process.listenerCount(String(name))])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    activeResources: process.getActiveResourcesInfo().length,
  };
}

/** One numeric scalar under the alias `n`, or null. The summary's SQLite reads all use it. */
function scalar(conn, sql) {
  return conn.prepare(sql).get()?.n ?? null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  compile();
  const { GenerationService, GenerationBus, openDatabase, countRows, createDb } = await load();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const mock = spawn(process.execPath, [MOCK_SERVER], {
    env: { ...process.env, PORT: String(port), FRAME_DELAY_MS: String(options.frameDelayMs) },
    stdio: "ignore",
  });
  await waitForHealth(base);

  const dir = mkdtempSync(join(tmpdir(), "cleon-soak-"));
  const dbPath = join(dir, "cleon.db");
  const conn = openDatabase(dbPath);
  const db = createDb(conn);

  const bus = new GenerationBus();
  const service = new GenerationService({
    db,
    bus,
    resolveConfig: async () => ({ baseUrl: base, apiKey: null }),
  });

  // A settle point so the release that follows a terminal event has run before the listener
  // count is read. `run` releases synchronously after emitting, but the check should not
  // depend on that ordering.
  const settleNow = () => new Promise((resolveSettle) => setImmediate(resolveSettle));

  const startedAt = Date.now();
  const deadline = startedAt + options.minutes * 60_000;

  const baseline = process.memoryUsage();
  const processBefore = processShape();
  const samples = [{ turn: 0, atMs: 0, rssMb: baseline.rss / MB, heapMb: baseline.heapUsed / MB }];
  const turns = [];
  const generationIds = new Set();
  const leakedListeners = [];
  let threadId = null;
  let turnsInThread = 0;
  let boundHit = "messages";
  let failure = null;

  console.log(
    `[soak] ${options.messages} turns max, ${options.minutes} min max, frame delay ${options.frameDelayMs} ms`,
  );

  for (let index = 0; index < options.messages; index += 1) {
    if (Date.now() >= deadline) {
      boundHit = "time";
      break;
    }

    let deltas = 0;
    let characters = 0;
    let settle = () => undefined;
    const terminal = new Promise((resolveTerminal) => {
      settle = resolveTerminal;
    });

    const turnStart = Date.now();
    try {
      const response = await service.send(
        threadId === null
          ? { threadId: null, text: `soak turn ${index + 1}`, model: "mock/text" }
          : { threadId, text: `soak turn ${index + 1}`, model: "mock/text" },
        (event) => {
          if (event.type === "delta") {
            deltas += 1;
            characters += event.text.length;
          }
          if (event.type === "done" || event.type === "error") settle(event);
        },
      );

      threadId = response.threadId;
      generationIds.add(response.generationId);

      /**
       * `--thread-turns` starts a new thread every N turns. Without it the run is one
       * conversation that grows forever, and after a few thousand turns the per-turn cost
       * is dominated by re-sending the whole history — a real cost, but not the thing a
       * leak hunt is trying to measure. Rotating keeps every turn's work bounded.
       */
      turnsInThread += 1;
      if (turnsInThread >= options.threadTurns) {
        threadId = null;
        turnsInThread = 0;
      }

      const final = await terminal;
      await settleNow();

      const elapsedMs = Date.now() - turnStart;
      const listeners = bus.listenerCount(response.generationId);
      if (listeners !== 0) {
        leakedListeners.push({ turn: index + 1, generationId: response.generationId, listeners });
      }

      const memory = process.memoryUsage();
      turns.push({
        turn: index + 1,
        generationId: response.generationId,
        terminal: final.type,
        elapsedMs,
        deltas,
        characters,
        listeners,
        rssMb: round(memory.rss / MB),
        heapMb: round(memory.heapUsed / MB),
      });
      samples.push({
        turn: index + 1,
        atMs: elapsedMs,
        rssMb: memory.rss / MB,
        heapMb: memory.heapUsed / MB,
      });

      if (final.type === "error") {
        failure = { turn: index + 1, message: `${final.error.code}: ${final.error.message}` };
        break;
      }
    } catch (error) {
      failure = {
        turn: index + 1,
        message: error instanceof Error ? error.message : String(error),
      };
      break;
    }

    if ((index + 1) % 25 === 0) {
      const last = samples.at(-1);
      console.log(
        `[soak] ${index + 1} turns · last turn ${last?.atMs ?? "?"} ms · RSS ${last?.rssMb.toFixed(1) ?? "?"} MB`,
      );
    }
  }

  const endedAt = Date.now();
  const processAfter = processShape();
  const rss = samples.map((sample) => sample.rssMb);
  const heap = samples.map((sample) => sample.heapMb);
  const drops = rss.filter((value, index) => index > 0 && value < (rss[index - 1] ?? value)).length;
  const heapDrops = heap.filter(
    (value, index) => index > 0 && value < (heap[index - 1] ?? value),
  ).length;
  const windowSize = Math.min(10, Math.floor(samples.length / 2));
  const firstWindow = rss.slice(0, windowSize);
  const lastWindow = rss.slice(-windowSize);

  const messages = countRows(conn, "messages");
  const threads = countRows(conn, "threads");
  const terminals = turns.filter((turn) => turn.terminal === "done").length;

  const result = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(endedAt).toISOString(),
    wallMs: endedAt - startedAt,
    boundHit,
    limits: {
      messages: options.messages,
      minutes: options.minutes,
      frameDelayMs: options.frameDelayMs,
    },
    turns: {
      attempted: turns.length,
      completed: terminals,
      failed: turns.filter((turn) => turn.terminal === "error").length,
      // Per-turn cost, from the turns that finished.
      elapsedMs: {
        min: Math.min(...turns.map((turn) => turn.elapsedMs)),
        p50:
          [...turns.map((turn) => turn.elapsedMs)].sort((a, b) => a - b)[
            Math.floor(turns.length / 2)
          ] ?? 0,
        max: Math.max(...turns.map((turn) => turn.elapsedMs)),
        mean: round(mean(turns.map((turn) => turn.elapsedMs))),
      },
      deltas: {
        total: turns.reduce((total, turn) => total + turn.deltas, 0),
        min: Math.min(...turns.map((turn) => turn.deltas)),
        max: Math.max(...turns.map((turn) => turn.deltas)),
      },
      characters: turns.reduce((total, turn) => total + turn.characters, 0),
    },
    memory: {
      baselineRssMb: round(baseline.rss / MB),
      peakRssMb: round(Math.max(...rss)),
      endRssMb: round(rss.at(-1) ?? 0),
      rssSlopeMbPerTurn: round(slope(samples.map((sample) => [sample.turn, sample.rssMb])), 4),
      rssDrops: drops,
      monotonic: drops === 0,
      firstWindowMeanRssMb: round(mean(firstWindow)),
      lastWindowMeanRssMb: round(mean(lastWindow)),
      windowSize,
      baselineHeapMb: round(baseline.heapUsed / MB),
      peakHeapMb: round(Math.max(...heap)),
      endHeapMb: round(heap.at(-1) ?? 0),
      heapSlopeMbPerTurn: round(slope(samples.map((sample) => [sample.turn, sample.heapMb])), 4),
      heapDrops,
      samples: samples.map((sample) => ({
        turn: sample.turn,
        rssMb: round(sample.rssMb),
        heapMb: round(sample.heapMb),
      })),
    },
    listeners: {
      leakedBusListeners: leakedListeners,
      generationsTouched: generationIds.size,
      processBefore,
      processAfter,
      processDelta: {
        activeResources: processAfter.activeResources - processBefore.activeResources,
        listeners: Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(processBefore.listeners),
              ...Object.keys(processAfter.listeners),
            ]),
          ]
            .map((name) => [
              name,
              (processAfter.listeners[name] ?? 0) - (processBefore.listeners[name] ?? 0),
            ])
            .filter(([, delta]) => delta !== 0),
        ),
      },
    },
    database: {
      path: options.keep ? dbPath : "(temporary, removed)",
      schemaVersion: scalar(conn, "SELECT MAX(version) AS n FROM schema_migrations"),
      threads,
      messages,
      expectedMessages: turns.length * 2,
      assistantFinished: scalar(
        conn,
        "SELECT count(*) AS n FROM generations WHERE ended_at IS NOT NULL",
      ),
    },
    failure,
  };

  console.log("\n=== soak result ===");
  console.log(
    `bound hit            ${boundHit} (${result.turns.attempted} turns, ${round(result.wallMs / 1000, 1)} s of ${options.minutes * 60} s)`,
  );
  console.log(
    `turns                 ${result.turns.completed} done, ${result.turns.failed} failed, ${result.turns.attempted} attempted`,
  );
  console.log(
    `per turn              p50 ${result.turns.elapsedMs.p50} ms, mean ${result.turns.elapsedMs.mean} ms, max ${result.turns.elapsedMs.max} ms`,
  );
  console.log(
    `deltas                ${result.turns.deltas.total} total (${result.turns.deltas.min}–${result.turns.deltas.max} per turn), ${result.turns.characters} chars`,
  );
  console.log(
    `RSS                   baseline ${result.memory.baselineRssMb} MB · peak ${result.memory.peakRssMb} MB · end ${result.memory.endRssMb} MB · slope ${result.memory.rssSlopeMbPerTurn} MB/turn`,
  );
  console.log(
    `RSS growth            ${result.memory.monotonic ? "monotonic (0 drops)" : `${result.memory.rssDrops} drops`} · first ${windowSize} mean ${result.memory.firstWindowMeanRssMb} MB · last ${windowSize} mean ${result.memory.lastWindowMeanRssMb} MB`,
  );
  console.log(
    `heap                  baseline ${result.memory.baselineHeapMb} MB · peak ${result.memory.peakHeapMb} MB · end ${result.memory.endHeapMb} MB · slope ${result.memory.heapSlopeMbPerTurn} MB/turn`,
  );
  console.log(
    `bus listeners         ${leakedListeners.length} leaked across ${generationIds.size} generations`,
  );
  console.log(
    `process               active resources Δ${result.listeners.processDelta.activeResources}, listener Δ${JSON.stringify(result.listeners.processDelta.listeners)}`,
  );
  console.log(
    `SQLite                v${result.database.schemaVersion} · ${result.database.threads} threads · ${result.database.messages} messages (expected ${result.database.expectedMessages}) · ${result.database.assistantFinished} generations finished`,
  );
  if (failure !== null)
    console.log(`failure               turn ${failure.turn}: ${failure.message}`);

  if (options.out !== null) {
    writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nwrote ${options.out}`);
  }

  mock.kill();
  conn.close();
  if (!options.keep) rmSync(dir, { recursive: true, force: true });

  // A crash, a failed turn, or a leaked listener is a failed soak, whatever the numbers say.
  if (failure !== null || leakedListeners.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[soak] failed:", error);
  process.exitCode = 1;
});

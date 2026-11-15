#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { compile, loadDbLayer, ROOT } from "./compile.mjs";
import { seed } from "./seed.mjs";

/**
 * The measurement harness G2 never had. `pnpm perf`.
 *
 * It measures four things against a real SQLite file through the app's own repository
 * layer — not through a copy, not through a mock:
 *
 *   1. `threads.list` p50/p95 over 200 calls, cold (the first call after opening the
 *      database in this process) and warm (200 calls after five untimed warm-ups).
 *   2. The FTS5 search branch of the same call, for a term that is in half the threads, so
 *      the query is 250 matching threads over 2 500 index rows rather than a term that
 *      matches nothing and returns in constant time.
 *   3. `chat.thread` — the tree read plus the attachment read the handler does — on a
 *      ten-message thread, 200 calls.
 *   4. A frame-gap proxy: the app is launched against the same 500-thread database, the
 *      sidebar is scrolled 20 times, and the worst gap between two `requestAnimationFrame`
 *      callbacks is reported. This is a proxy, not a profiler trace: it says "no frame took
 *      longer than N ms while the list was scrolling", not why.
 *
 * The corpus is seeded fresh on every run, so the numbers are comparable between runs on
 * the same machine. `PERF.md` is rewritten each time, with the machine and the date.
 */

const CALLS = 200;
const WARMUPS = 5;
const SEARCH_TERM = "heron";
/** 500 threads × 10 messages, the size G2's clause names. */
const THREADS = 500;
const MESSAGES = 10;
/** The sidebar asks for one page of 200 (`THREAD_PAGE_SIZE` in the renderer). */
const LIST_LIMIT = 200;
const G2_P95_TARGET_MS = 100;

function percentile(sortedSamples, fraction) {
  if (sortedSamples.length === 0) return Number.NaN;
  if (sortedSamples.length === 1) return sortedSamples[0];
  const position = (sortedSamples.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedSamples[lower];
  const weight = position - lower;
  return sortedSamples[lower] * (1 - weight) + sortedSamples[upper] * weight;
}

function summarise(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/** One timed call, in milliseconds, from `process.hrtime.bigint()`. */
function timeOnce(run) {
  const started = process.hrtime.bigint();
  const value = run();
  const ended = process.hrtime.bigint();
  return { ms: Number(ended - started) / 1e6, value };
}

function ms(value) {
  return `${value.toFixed(2)} ms`;
}

function machine() {
  const cpu = cpus()[0];
  return {
    cpu: cpu === undefined ? "unknown" : cpu.model,
    cores: cpus().length,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    platform: `${platform()} ${release()}`,
    node: process.version,
  };
}

/* ------------------------------------------------------------------ scroll */

/**
 * The frame-gap proxy.
 *
 * Sampled with `requestAnimationFrame` inside the renderer: each callback records the gap
 * since the previous one, and the scroll steps run while it samples. A 60 Hz display gives
 * ~16.7 ms to a frame, so the interesting number is how far above that the worst gap goes.
 * Throttling is checked rather than assumed — a backgrounded window gives gaps in the
 * hundreds of milliseconds for reasons that have nothing to do with the app, and reporting
 * one of those as a scroll cost would be a lie.
 */
async function measureFrames(userData, dbPath) {
  if (!existsSync(join(ROOT, "out/main/index.js"))) {
    return {
      measured: false,
      reason: "the app is not built; run `pnpm build` first",
    };
  }

  const { _electron } = await import("@playwright/test");
  const env = { ...process.env, CLEON_USER_DATA: userData };
  delete env.CLEON_API_BASE;

  const app = await _electron.launch({ args: ["."], cwd: ROOT, env });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('[data-testid="thread-list"]', { timeout: 30_000 });
    // The windowed list has to have measured its viewport before a scroll means anything.
    await win.waitForFunction(
      () => document.querySelectorAll('[data-testid="thread-row"]').length > 0,
      undefined,
      { timeout: 30_000 },
    );

    const before = await win.evaluate(() => {
      const list = document.querySelector('[data-testid="thread-list"]');
      return {
        rows: document.querySelectorAll('[data-testid="thread-row"]').length,
        scrollHeight: list === null ? 0 : list.scrollHeight,
        scrollTop: list === null ? 0 : list.scrollTop,
      };
    });

    await win.evaluate(() => {
      const probe = { gaps: [], last: null, active: true };
      globalThis.__cleonFrameProbe = probe;
      const tick = (timestamp) => {
        if (!probe.active) return;
        if (probe.last !== null) probe.gaps.push(timestamp - probe.last);
        probe.last = timestamp;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    for (let step = 1; step <= 20; step += 1) {
      await win.evaluate(
        (offset) => {
          const list = document.querySelector('[data-testid="thread-list"]');
          if (list !== null) list.scrollTop = offset;
        },
        step * 96 * 5,
      );
      await win.waitForTimeout(50);
    }

    const { gaps, after } = await win.evaluate(() => {
      const probe = globalThis.__cleonFrameProbe;
      probe.active = false;
      const list = document.querySelector('[data-testid="thread-list"]');
      return { gaps: probe.gaps, after: list === null ? 0 : list.scrollTop };
    });

    const summary = summarise(gaps);
    const throttled = Number.isFinite(summary.p50) && summary.p50 > 100;
    return {
      measured: gaps.length >= 10 && !throttled,
      reason: throttled
        ? `rAF was throttled (median gap ${ms(summary.p50)}); the window was not painting`
        : gaps.length < 10
          ? `only ${gaps.length} frames were observed`
          : null,
      worst: summary.max,
      p50: summary.p50,
      p95: summary.p95,
      frames: summary.n,
      domRows: before.rows,
      scrollHeight: before.scrollHeight,
      scrolledTo: after,
      dbPath,
    };
  } finally {
    await app.close();
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  compile();

  const directory = mkdtempSync(join(tmpdir(), "cleon-perf-run-"));
  const dbPath = join(directory, "cleon.db");
  const startedAt = new Date();
  const results = {};

  try {
    const seeded = await seed({ threads: THREADS, messages: MESSAGES, dbPath });
    const { threadIds, ...seedSummary } = seeded;
    results.seed = seedSummary;

    const layer = await loadDbLayer();
    const conn = layer.openDatabase(dbPath);
    const db = layer.createDb(conn);
    const listRequest = { limit: LIST_LIMIT, offset: 0, includeArchived: false };

    // 1. Cold: the very first list call in this process, before anything has warmed the
    //    page cache or the statement cache.
    const cold = timeOnce(() => layer.listThreads(db, listRequest));
    results.cold = { ms: cold.ms, total: cold.value.total };

    // Warm-ups, deliberately not measured: the first few calls after a cold one are still
    // paying for plan preparation, and a p95 that includes them measures start-up.
    for (let index = 0; index < WARMUPS; index += 1) layer.listThreads(db, listRequest);

    const listSamples = [];
    for (let index = 0; index < CALLS; index += 1) {
      const timed = timeOnce(() => layer.listThreads(db, listRequest));
      listSamples.push(timed.ms);
    }
    results.list = summarise(listSamples);
    results.list.total = cold.value.total;
    results.list.items = cold.value.items.length;

    // 2. The search branch, same call, with a term that is in half the threads.
    const searchRequest = { ...listRequest, query: SEARCH_TERM };
    const firstSearch = layer.listThreads(db, searchRequest);
    results.search = { matched: firstSearch.total, items: firstSearch.items.length };
    for (let index = 0; index < WARMUPS; index += 1) layer.listThreads(db, searchRequest);

    const searchSamples = [];
    for (let index = 0; index < CALLS; index += 1) {
      searchSamples.push(timeOnce(() => layer.listThreads(db, searchRequest)).ms);
    }
    results.search = { ...results.search, ...summarise(searchSamples) };

    // 3. `chat.thread`: the tree read plus the attachment read, which is exactly what the
    //    IPC handler does for one thread.
    const threadId = threadIds[0];
    const readThread = () => {
      const tree = layer.getThreadTree(db, threadId);
      layer.listAttachmentsForMessages(
        db,
        tree.messages.map((message) => message.id),
      );
      return tree;
    };
    const firstRead = readThread();
    results.thread = { messages: firstRead.messages.length };
    for (let index = 0; index < WARMUPS; index += 1) readThread();

    const readSamples = [];
    for (let index = 0; index < CALLS; index += 1) {
      readSamples.push(timeOnce(readThread).ms);
    }
    results.thread = { ...results.thread, ...summarise(readSamples) };

    results.sqlite = conn.prepare("SELECT sqlite_version() AS v").get().v;
    results.schemaVersion = layer.schemaVersion(conn);
    conn.close();

    // 4. The frame proxy, against the same database, with the app built.
    results.frames = await measureFrames(directory, dbPath);

    const report = renderReport({ startedAt, results });
    writeFileSync(join(ROOT, "PERF.md"), report);
    console.log(renderConsole(results));
    console.log("\nwrote PERF.md");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/* ----------------------------------------------------------------- report */

function verdict(results) {
  if (!Number.isFinite(results.list.p95)) return "not measured";
  return results.list.p95 < G2_P95_TARGET_MS ? "pass" : "MISS";
}

function renderConsole(results) {
  const rows = [
    ["threads.list cold (n=1)", ms(results.cold.ms), "—"],
    ["threads.list warm (p50/p95)", ms(results.list.p50), ms(results.list.p95)],
    [`search "${SEARCH_TERM}" (p50/p95)`, ms(results.search.p50), ms(results.search.p95)],
    ["chat.thread read (p50/p95)", ms(results.thread.p50), ms(results.thread.p95)],
  ];
  const width = Math.max(...rows.map((row) => row[0].length)) + 2;
  const lines = rows.map(
    (row) => `${row[0].padEnd(width)}${row[1].padStart(12)}${row[2].padStart(12)}`,
  );
  const frames = results.frames.measured
    ? `worst frame gap: ${ms(results.frames.worst)} over ${results.frames.frames} frames (proxy)`
    : `frame gap: not measured — ${results.frames.reason}`;
  return [
    `corpus: ${results.seed.threads} threads × ${results.seed.messages} messages (${results.seed.seedMs} ms to seed)`,
    `search matched ${results.search.matched} threads, list returned ${results.list.items} of ${results.list.total}`,
    "",
    `${"measurement".padEnd(width)}${"p50".padStart(12)}${"p95".padStart(12)}`,
    ...lines,
    "",
    frames,
    `G2 target (p95 < ${G2_P95_TARGET_MS} ms): ${verdict(results)}`,
  ].join("\n");
}

function renderReport({ startedAt, results }) {
  const spec = machine();
  const frames = results.frames;
  const frameSection = frames.measured
    ? `The app was launched against the 500-thread database and the sidebar was scrolled 20
times, ${frames.domRows} rows at a time in the DOM (the list is windowed, and the sidebar
holds the app's own page of ${LIST_LIMIT}), with \`requestAnimationFrame\` gaps sampled in the
renderer for the duration. \`scrollTop\` went from 0 to ${Math.round(frames.scrolledTo)} of a
${Math.round(frames.scrollHeight)} px scroll range.

| | value |
|---|---|
| Worst frame gap | **${ms(frames.worst)}** |
| p50 gap | ${ms(frames.p50)} |
| p95 gap | ${ms(frames.p95)} |
| Frames sampled | ${frames.frames} |

**This is a proxy, not a profiler trace.** It says no frame took longer than the worst gap
while the list was scrolling; it does not say why, and it does not attribute the time to
windowing, layout or paint. A 60 Hz display gives ~16.7 ms per frame, so the number to read
is the distance above that.`
    : `**Not measured.** ${frames.reason}.`;

  return `# Performance

Measured by \`pnpm perf\` (\`scripts/perf/measure.mjs\`), which is the only source of the
numbers below. Nothing here is estimated or rounded up.

- **Date:** ${startedAt.toISOString()}
- **Machine:** ${spec.cpu} · ${spec.cores} cores · ${spec.memoryGb} GB RAM · ${spec.platform}
- **Runtime:** Node ${spec.node} · SQLite ${results.sqlite} (via \`better-sqlite3\`)
- **Schema:** v${results.schemaVersion}
- **Corpus:** ${results.seed.threads} threads × ${MESSAGES} messages
  (${results.seed.messages} message rows, ${results.seed.ftsRows} FTS5 rows), seeded in
  ${results.seed.seedMs} ms through the app's own repository layer

## Method

The database is created fresh in a temporary directory by \`scripts/perf/seed.mjs\`, which
inserts rows with \`createThread\` / \`insertMessage\` / \`touchThread\` from
\`src/main/db/repo.ts\` — so the FTS5 triggers fire exactly as they do in the app. The
measurement loads the same module (\`tsc\`-compiled to \`scripts/perf/.build\`) and calls:

- \`listThreads({ limit: 200, offset: 0, includeArchived: false })\` — the sidebar's own page
  size, ${results.list.items} rows of ${results.list.total} returned.
- \`listThreads\` with \`query: "${SEARCH_TERM}"\` — the FTS5 branch. Half the threads carry
  the term, so this matches ${results.search.matched} threads over ${results.seed.ftsRows} index
  rows: BM25 over every hit, \`snippet()\` for each, and \`ROW_NUMBER()\` to keep one row per
  thread.
- \`getThreadTree\` + \`listAttachmentsForMessages\` for one thread — belt and braces, exactly
  the two reads \`chat.thread\` performs.

Each timed section runs ${results.list.n} calls after ${WARMUPS} untimed warm-ups, timed with
\`process.hrtime.bigint()\`. Percentiles are linear-interpolated between closest ranks (the
numpy default). "Cold" is the **first** call in the process: n=1, so it is a single
observation and not a percentile — it is here because it is the call a user's first window
pays for.

## Results

| Measurement | p50 | p95 | n |
|---|---|---|---|
| \`threads.list\` (cold) | — | — | 1 (${ms(results.cold.ms)}) |
| \`threads.list\` (warm) | ${ms(results.list.p50)} | **${ms(results.list.p95)}** | ${results.list.n} |
| FTS search \`"${SEARCH_TERM}"\` | ${ms(results.search.p50)} | **${ms(results.search.p95)}** | ${results.search.n} |
| \`chat.thread\` (10 messages) | ${ms(results.thread.p50)} | **${ms(results.thread.p95)}** | ${results.thread.n} |

Min/max over the same samples: \`threads.list\` ${ms(results.list.min)}–${ms(results.list.max)},
search ${ms(results.search.min)}–${ms(results.search.max)}, \`chat.thread\`
${ms(results.thread.min)}–${ms(results.thread.max)}.

## G2's target: p95 < ${G2_P95_TARGET_MS} ms

**${verdict(results) === "pass" ? "PASS" : "NOT MET"}** — the slowest p95 above is
${ms(Math.max(results.list.p95, results.search.p95, results.thread.p95))} against a target of
${G2_P95_TARGET_MS} ms. ${
    verdict(results) === "pass"
      ? "The clause is met on this machine with this corpus."
      : "Written down as a miss rather than rounded up: the gate's number was never measured in D2, and it is not met here."
  }

G2's clause is "500 threads · p95 < ${G2_P95_TARGET_MS} ms · 60 fps". The first two parts are
the table above and the corpus it ran against. The third is the frame proxy below, and it is
a proxy: proving "60 fps" needs a profiler trace, which this harness does not produce.

## Frame-rate proxy

${frameSection}

## What this does not measure

- **No IPC.** The measurements call the repository functions the handlers call, not the
  handlers through Electron's IPC, so serialise / \`postMessage\` / deserialise is outside every
  number here. The gate's clause is about the query at 500 threads, and the exclusion is real.
- **No profiler trace.** The frame gap is a wall-clock gap between rAF callbacks; it cannot
  say whether a long gap was script, style, layout or paint.
- **One machine, one corpus.** Numbers are comparable between runs on this machine; they
  are not a promise about a slower CPU, a spinning disk, or a cold file system. The seed is
  deterministic, so a diff between two runs is a diff in the code or the machine.
- **The renderer's cost of rendering a page** is only partly in here: \`threads.list\` measures
  the IPC side, and the frame proxy covers scrolling a windowed list, not first paint.
- **WAL, not a fresh disk.** The database is opened with the app's pragmas (WAL,
  \`synchronous = NORMAL\`), so writes are not part of these numbers at all.
`;
}

await main();

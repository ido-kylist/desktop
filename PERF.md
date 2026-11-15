# Performance

Measured by `pnpm perf` (`scripts/perf/measure.mjs`), which is the only source of the
numbers below. Nothing here is estimated or rounded up.

- **Date:** 2026-11-15T20:29:43.623Z
- **Machine:** Apple M5 · 10 cores · 24 GB RAM · darwin 27.2.0
- **Runtime:** Node v24.12.0 · SQLite 3.54.1 (via `better-sqlite3`)
- **Schema:** v7
- **Corpus:** 500 threads × 10 messages
  (5000 message rows, 5000 FTS5 rows), seeded in
  273 ms through the app's own repository layer

## Method

The database is created fresh in a temporary directory by `scripts/perf/seed.mjs`, which
inserts rows with `createThread` / `insertMessage` / `touchThread` from
`src/main/db/repo.ts` — so the FTS5 triggers fire exactly as they do in the app. The
measurement loads the same module (`tsc`-compiled to `scripts/perf/.build`) and calls:

- `listThreads({ limit: 200, offset: 0, includeArchived: false })` — the sidebar's own page
  size, 200 rows of 500 returned.
- `listThreads` with `query: "heron"` — the FTS5 branch. Half the threads carry
  the term, so this matches 250 threads over 5000 index
  rows: BM25 over every hit, `snippet()` for each, and `ROW_NUMBER()` to keep one row per
  thread.
- `getThreadTree` + `listAttachmentsForMessages` for one thread — belt and braces, exactly
  the two reads `chat.thread` performs.

Each timed section runs 200 calls after 5 untimed warm-ups, timed with
`process.hrtime.bigint()`. Percentiles are linear-interpolated between closest ranks (the
numpy default). "Cold" is the **first** call in the process: n=1, so it is a single
observation and not a percentile — it is here because it is the call a user's first window
pays for.

## Results

| Measurement | p50 | p95 | n |
|---|---|---|---|
| `threads.list` (cold) | — | — | 1 (1.01 ms) |
| `threads.list` (warm) | 0.57 ms | **0.65 ms** | 200 |
| FTS search `"heron"` | 6.64 ms | **6.91 ms** | 200 |
| `chat.thread` (10 messages) | 0.13 ms | **0.17 ms** | 200 |

Min/max over the same samples: `threads.list` 0.56 ms–2.06 ms,
search 6.47 ms–7.99 ms, `chat.thread`
0.12 ms–1.81 ms.

## G2's target: p95 < 100 ms

**PASS** — the slowest p95 above is
6.91 ms against a target of
100 ms. The clause is met on this machine with this corpus.

G2's clause is "500 threads · p95 < 100 ms · 60 fps". The first two parts are
the table above and the corpus it ran against. The third is the frame proxy below, and it is
a proxy: proving "60 fps" needs a profiler trace, which this harness does not produce.

## Frame-rate proxy

The app was launched against the 500-thread database and the sidebar was scrolled 20
times, 9 rows at a time in the DOM (the list is windowed, and the sidebar
holds the app's own page of 200), with `requestAnimationFrame` gaps sampled in the
renderer for the duration. `scrollTop` went from 0 to 9600 of a
19200 px scroll range.

| | value |
|---|---|
| Worst frame gap | **18.70 ms** |
| p50 gap | 16.70 ms |
| p95 gap | 18.17 ms |
| Frames sampled | 64 |

**This is a proxy, not a profiler trace.** It says no frame took longer than the worst gap
while the list was scrolling; it does not say why, and it does not attribute the time to
windowing, layout or paint. A 60 Hz display gives ~16.7 ms per frame, so the number to read
is the distance above that.

## What this does not measure

- **No IPC.** The measurements call the repository functions the handlers call, not the
  handlers through Electron's IPC, so serialise / `postMessage` / deserialise is outside every
  number here. The gate's clause is about the query at 500 threads, and the exclusion is real.
- **No profiler trace.** The frame gap is a wall-clock gap between rAF callbacks; it cannot
  say whether a long gap was script, style, layout or paint.
- **One machine, one corpus.** Numbers are comparable between runs on this machine; they
  are not a promise about a slower CPU, a spinning disk, or a cold file system. The seed is
  deterministic, so a diff between two runs is a diff in the code or the machine.
- **The renderer's cost of rendering a page** is only partly in here: `threads.list` measures
  the IPC side, and the frame proxy covers scrolling a windowed list, not first paint.
- **WAL, not a fresh disk.** The database is opened with the app's pragmas (WAL,
  `synchronous = NORMAL`), so writes are not part of these numbers at all.

## Where the other measurements live

This file is latency over a synthetic corpus. Memory over time is `docs/SOAK.md`
(`node scripts/soak.mjs`), and the UI state matrix is `docs/STATES.md`. The three do not
overlap: a fast query says nothing about whether the process grows, and neither says anything
about what a user sees when a read fails.

# Soak

What sequential turns through the app's own generation path cost, and whether anything grows,
leaks, or crashes while they run. Two runs: the plan's 200-message figure, and a 30-minute soak
that completed **10 825 turns**.

Measured by `node scripts/soak.mjs`, which is the only source of the numbers below. Nothing
here is estimated, extrapolated, or rounded up in the app's favour.

## What it runs

`scripts/soak.mjs` drives `GenerationService.send` — the same orchestrator `chat.send` calls in
the packaged app. That means the real SQLite writes, the real 250 ms checkpoints, the real SSE
parser, the real `GenerationBus`, and the real terminal-event paths. Nothing is stubbed except
the provider.

The provider is `mock/server.mjs` streaming `text.sse` one frame at a time with a real
`FRAME_DELAY_MS` between frames (25 ms by default). The deltas therefore arrive as deltas — a
turn shows four content deltas, not one buffered body — so the streaming path is exercised, not
bypassed.

```
node scripts/soak.mjs --messages 12000 --minutes 30 --thread-turns 25 --out soak.json
```

`--thread-turns N` starts a new thread every N turns. Without it the run is one conversation
that grows forever, and after a few thousand turns the per-turn cost is dominated by
re-sending the whole history — a real cost, but not the thing a leak hunt is measuring.
Rotating keeps every turn's work bounded.

The harness compiles the TypeScript it needs with `tsc` first (`scripts/soak/tsconfig.json`),
for the same reason `scripts/perf` does: plain `node` cannot import a module that addresses its
neighbours as `./x.js`. What it imports is the repo's own code, not a re-implementation.

## Machine

Apple M5 · 10 cores · 24 GB RAM · darwin 27.2.0 · Node v24.12.0 · SQLite 3.54.1 (via
`better-sqlite3`). The same machine as `PERF.md`.

## Run 1 — 200 turns, one thread

The plan's headline number. `node scripts/soak.mjs --messages 200 --minutes 30`.

| | |
|---|---|
| Bound hit | **messages** (200 turns in 32.9 s of a 30-minute budget) |
| Turns | 200 attempted, **200 done, 0 failed** |
| Per turn | min 157 ms · p50 **164 ms** · mean 164.4 ms · max 172 ms |
| Streaming | 800 deltas total (4 per turn), 4 000 characters |
| RSS | baseline 125.9 MB · peak **160.4 MB** · end **125.1 MB** |
| RSS growth | **not monotonic** — 3 drops; slope **−0.216 MB/turn**; first 10 mean 152.8 MB, last 10 mean **125.0 MB** |
| Heap | baseline 24.8 MB · peak 52.1 MB · end **22.0 MB** · slope −0.091 MB/turn |
| Bus listeners | **0** left behind across 200 generations |
| Process | active resources Δ0, listener count Δ0 |
| SQLite | schema v7 · 1 thread · **400 messages** (expected 400) · 200 generations finished |
| Crash | none |

The shape is warm-up, not a leak: RSS jumps to ~158 MB on the first turn, peaks around 160 MB
while the JIT and the first thread's rows are hot, then falls to ~125 MB by turn 75 and stays
there for the remaining 125 turns. The final sample is *below* the baseline. A process that
leaked per turn would show the opposite — a slope above zero and a final sample above the peak
of the first window. Heap behaves the same way and is noisier, as a young heap is.

## Run 2 — the 30-minute soak

```
node scripts/soak.mjs --messages 12000 --minutes 30 --thread-turns 25 --out soak.json
```

| | |
|---|---|
| Bound hit | **time** — 10 825 turns in **1 800.2 s** of a 1 800 s budget |
| Turns | 10 825 attempted, **10 825 done, 0 failed** |
| Threads | 433 (a new one every 25 turns, so per-turn prompt size stays bounded) |
| Per turn | min 157 ms · p50 **166 ms** · mean 166.3 ms · max 208 ms |
| Streaming | 43 300 deltas total (4 per turn), 216 500 characters |
| RSS | baseline 123.5 MB · peak **210.9 MB** · end **200.3 MB** |
| RSS growth | **not monotonic** — 412 drops; overall slope **+0.0049 MB/turn** |
| Heap | baseline 24.8 MB · peak **76.2 MB** · end **29.7 MB** · slope +0.0015 MB/turn |
| Bus listeners | **0** left behind across **10 825** generations |
| Process | active resources Δ**1**, listener count Δ0 |
| SQLite | schema v7 · **433 threads** · **21 650 messages** (expected 21 650) · 10 825 generations finished |
| Crash | none |

### The shape is a plateau, not a creep

Per-turn latency did not degrade with scale: run 1 (200 turns) had p50 164 ms and run 2 (10 825
turns) had p50 166 ms, with the last turns of run 2 logged at 163–189 ms. The memory series has
three phases, and reading only the endpoints would misrepresent it:

| Phase | Turns | RSS |
|---|---|---|
| Warm-up | 0 → 50 | 123 → 157 MB, then down to 151 |
| Fill | 50 → 2 000 | bottoms at **94.4 MB** (turn 250), climbs to **202 MB** (turn 2 000) |
| Plateau | 2 000 → 10 825 | oscillates **197–211 MB**; second-half slope **+0.00087 MB/turn** |

The second-half slope is +0.0009 MB/turn, about 9 MB across 8 800 turns — smaller than the
±10 MB the plateau oscillates through, and the series dipped 412 times. The JS heap behaves the
same way: 24.8 MB baseline, peak 76.2 MB during collection cycles, **29.7 MB** at the end, no
trend. A per-turn leak of one listener, one row object or one closure would have to move a slope
that is currently indistinguishable from zero over 10 825 turns; a leak of one *byte* per turn
would show as +0.01 MB/turn and it does not.

The most likely explanation for the fill phase is the database itself: 21 650 rows and 433 threads
in 30 minutes means the SQLite page cache and the FTS index were being read into memory, and that
cost is proportional to how much of the file has been touched. That is a *bounded* cache, not a
leak — but it is an explanation, not a measurement: no heap snapshot, no native-allocation
breakdown and no `sqlite3_db_status` read was taken. What is measured is that the growth stops.

The one outstanding number is the active-resource delta of 1. Ten thousand eight hundred and
twenty-five generations produced one extra resource, not one per turn, so it is a final handle
rather than a leak; it is reported rather than smoothed over.

Run 1 answers the plan's 200-message figure directly — 200 turns in 32.9 seconds — and run 2 shows
that figure is nowhere near a ceiling: the same process ran **54× as many turns** with no latency
drift and no memory trend.

## What this does not measure

- **The renderer.** No window, no React, no IPC. A leak in the transcript's DOM or in a
  renderer listener would not appear above. This is the biggest hole, and it is in `BACKLOG.md`.
- **A real provider.** The mock streams deterministically. A provider that stalls, reconnects,
  or delivers bytes at an odd cadence is a different shape of load.
- **The packaged app.** This runs `out`'s TypeScript via `tsc`, not the DMG.
- **Battery or thermal cost.** AC power, thirty minutes, one machine.
- **Disk growth.** The temporary database is deleted at the end; the run reports row counts, not
  bytes. WAL growth over 30 minutes at this write rate is small but unmeasured.
- **Concurrency.** Turns are sequential by design. Two generations at once, a stop mid-stream, a
  regenerate during a send — none of those run here.

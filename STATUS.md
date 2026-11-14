# Status

The only coordination surface. If it is not here, it is not agreed.

**Updated:** 2026-11-14 · phase **D2** (next) · last gate **G1 passed (mock)**

## Phase board

| Phase | Gate | State |
|---|---|---|
| D0 Foundation | G0 | **passed** — `gates/G0.md` |
| D0.5 Rehearsal | R0 | **passed** — `gates/R0.md` |
| D1 Vertical slice | G1 | **passed against the mock** — `gates/G1.md`; real-key leg needs a credential |
| D2 History & search | G2 | not started — next |

## Done

- Repo, CI, branch protection enforced (admins included), secret push protection.
- Frozen IPC contract, now protocol **v3**; preload is sandboxed CJS with one `require`.
- Schema v1 + FTS5, inline migrations checksummed at apply.
- Mock inference server, 6 fixtures, 6/6 contract tests.
- DMG builds, installs, launches; packaged-app e2e passes.
- D0.5: throwaway feature through the full pipeline; five findings in `gates/R0.md`.
- D1: secrets behind `safeStorage` (fail-closed, key never leaves main), SSE parser
  (34 tests, byte-offset splits), inference client with 402/429/truncated mapping,
  generation events with idempotent `seq`, persistence with 250 ms checkpoints,
  hand-built chat surface, and the **relaunch-restores** proof.
- Nine PRs merged through the protected branch.

## Now

Nothing in flight. D2 (history, folders, FTS5 search, virtualization) is next and needs a
kickoff brief.

## Next

D2 and the standing obligations it inherits: pagination and search over the existing schema,
a restore path that survives a remembered thread id the DB no longer has, and the deferred
items in `BACKLOG.md` — most relevantly persisted reasoning/tool blocks and a real markdown
parser.

## Open questions (owner)

- None blocking. Two owner-only items: the **real-key leg of G1**, and the DMG remains
  unsigned until a Developer ID certificate exists.


## Rules in force

One writer per file · disjoint directories · briefs not transcripts · artifacts on disk ·
authors never grade their own work · no gate weakened to pass.

# Status

The only coordination surface. If it is not here, it is not agreed.

**Updated:** 2026-11-14 · phase **D0.5** (rehearsal) · gate **R0**

## Phase board

| Phase | Gate | State |
|---|---|---|
| D0 Foundation | G0 | **passed** — see `gates/G0.md` |
| D0.5 Rehearsal | R0 | in progress |
| D1 Vertical slice … | G1 | not started |

## Done

- Repo, CI, branch protection enforced (admins included), secret push protection.
- Frozen IPC contract, protocol v1; preload is sandboxed CJS with one `require`.
- Schema v1 + FTS5, inline migrations checksummed at apply.
- Mock inference server, 6 fixtures, 6/6 contract tests.
- DMG builds, installs, launches; packaged-app e2e passes.
- CI green on `main`; the first PR (#1) merged through the new gate.

## Now

D0.5: prove the pipeline once, on something disposable, before it costs a day.
One throwaway feature → worker → Reviewer A → Verifier → gate log.

## Next

D1 vertical slice (the riskiest five hours): `safeStorage`, catalog, SSE parser,
`generation.*` events, chat store, hand-built message surface, persistence.

## Open questions (owner)

- None blocking. Repo is public; write access remains the single owner, and `main`
  cannot be pushed to directly by anyone including the owner.

## Rules in force

One writer per file · disjoint directories · briefs not transcripts · artifacts on disk ·
authors never grade their own work · no gate weakened to pass.

## What this changes

<!-- One paragraph. What behaviour is different after this PR? -->

## Gate

<!-- Which phase/gate does this serve? e.g. D0 / G0 -->

## Evidence

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` clean
- [ ] `npx playwright test` clean
- [ ] If this touched the IPC contract, `PROTOCOL_VERSION` was bumped and both sides updated

## Honesty checks

- [ ] No gate weakened to make this pass
- [ ] No `any`, no `@ts-expect-error`, no non-null assertion
- [ ] Any user-visible failure has a distinct state (no silent fallthrough)
- [ ] Anything cut is recorded in `BACKLOG.md`

## Screenshots / logs

<!-- For UI or behavioural changes, paste what you actually saw. -->

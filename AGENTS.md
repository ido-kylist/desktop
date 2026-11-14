# AGENTS.md — the quality canon

This repo is built by agents under human ownership. These rules are not style
preferences; each one exists because breaking it produced a real defect.

## The invariants (never negotiate these)

1. **The renderer is sandboxed.** `sandbox: true`, `contextIsolation: true`,
   `nodeIntegration: false`, custom `app://` scheme, no remote code. A change that
   weakens any of these is rejected, not discussed.
2. **The API key never enters the renderer.** The renderer sends intent; main
   attaches credentials.
3. **Main owns all SQL.** The renderer never sees a table name, a row, or a query.
4. **Every IPC channel is declared once** in `src/shared/channels.ts` and
   `src/shared/ipc-contract.ts`, with Zod request and response schemas. The
   `satisfies Record<ChannelName, Contract>` clause keeps the two halves in sync.
   Adding or changing a channel bumps `PROTOCOL_VERSION`.
5. **Streaming is a typed event stream** with monotonic `seq` and a stable
   `generationId`, applied idempotently. Persist the user message before the
   network call; checkpoint every 250 ms; resume from the last checkpoint.

## Working rules

- **Contracts are frozen at D0.** Changing one is a deliberate act with a version bump.
- **One writer per file.** Parallel work happens across disjoint directories, never inside one file.
- **Authors never grade their own work.** If you wrote it, someone else verifies it.
- **Briefs, not transcripts.** Hand off the smallest context that makes the task unambiguous.
- **Artifacts on disk.** State lives in the repo and in gate logs, never only in a conversation.
- **No gate is weakened to pass.** If a check fails, the code is wrong or the check was wrong from the start — say which.
- **Never fabricate.** No fake signatures, no simulated test output, no "should work" in place of a run.

## Code standards

- TypeScript strict. **No `any`**, no `@ts-expect-error`, no non-null assertions.
- Types are derived from Zod schemas (`z.infer`), never hand-written alongside them.
- Biome for lint and format: `pnpm lint:fix`.
- Schema nullability matches the database exactly.
- `z.uuid()` for UUIDs, `z.email()` for email, `z.iso.datetime()` for timestamps.
- Prefer the platform: no dependency is added without a note in `docs/DECISIONS.md`.

## Testing bar

- **Database code is tested against real SQLite**, not a mock.
- Every new permission or gate gets a matrix test: every role that passes, every role that fails, and the fail-closed path.
- Every mutating service method is tested for the happy path, the idempotent call, the not-found case, and its guard conditions.
- Every user-visible failure has a test proving the UI shows a distinct state.
- `pnpm test` for unit and integration, `npx playwright test` for the real app.

## Before you call it done

- [ ] `pnpm typecheck` · `pnpm lint` · `pnpm test` · `npx playwright test` all clean
- [ ] The thing you changed is exercised by a test that would fail without your change
- [ ] No comment describes behaviour the code no longer has
- [ ] Anything you cut is in `BACKLOG.md`

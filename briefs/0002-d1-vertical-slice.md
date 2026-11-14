# Brief 0002 — D1 vertical slice

**Phase:** D1 · **Gate:** G1 · **Deadline slot:** the riskiest five hours

One thread, one model, one stream: prove that a message can be sent, answered token by
token, and still be there after the app is quit and relaunched. Nothing else is in scope.

**Gate G1:** real key → stream → quit → relaunch restores.

## Slices

Each slice is its own branch and PR. One writer per slice. A slice is not merged until the
Verifier has run the gate on it independently.

### D1a — secrets and transport primitives (no UI, no DB)

- `src/main/secrets.ts` — async `safeStorage` wrapper behind an injected interface so the
  logic is testable without Electron. `setApiKey`, `getApiKey`, `hasKey`, `clearKey`.
  The key **never** crosses IPC and never reaches the renderer; expose only `hasKey` and a
  masked last-4 for display.
- `src/main/api/sse.ts` — SSE frame parser over a byte/string stream. Must handle: multi-line
  `data:` fields, comment lines, CRLF, `[DONE]`, a frame split across chunks, a malformed
  frame (surface, don't crash), and EOF mid-frame.
- Unit tests for both. No dependencies.

### D1b — inference client, generation events, persistence

- `src/main/api/client.ts` — OpenAI-compatible streaming client. Base URL configurable so the
  mock server is a first-class target.
- `src/main/api/generations.ts` — orchestration: persist the user message **before** the
  network call; emit `generation.*` events with monotonic `seq` and a stable `generationId`;
  checkpoint every 250 ms; on failure emit `error` and leave a resumable state.
- Error taxonomy wired to the contract: 402 → `BUDGET_EXCEEDED`, 429 → `RATE_LIMITED` with
  `retryAfterMs` from `Retry-After`, truncated stream → `UPSTREAM_TRUNCATED`.
- New channels: `secrets.hasKey`, `secrets.setKey`, `secrets.clearKey`, `chat.send`,
  `chat.stop`, plus a `generation.event` push channel (main → renderer).
- Persistence through the existing schema; no new tables.

### D1c — chat surface (hand-built, no assistant-ui)

- Zustand store + TanStack Query where it earns its keep.
- Custom message list, streaming markdown, composer, stop button, per-message error state.
- Typed view state, no router.
- Must render: streaming text, reasoning block collapsed by default, error banner with the
  contract's error code, and a retry affordance.

### D1d — wire-up and the gate

- e2e: send against the mock → stream renders → quit → relaunch → thread restored.
- Fault injection behind a dev flag so the renderer error states are reachable in tests
  (R0 finding 3).
- No protocol literals in tests; assert `window.cleon.protocolVersion` (R0 finding 2).
- e2e script builds first (R0 finding 5).

## Constraints

- Protocol version bumps to 2 with the first real channel change and stays monotonic.
- No new dependencies without a `docs/DECISIONS.md` entry.
- The renderer never sees a key, a table name, or a query.
- Anything cut goes in `BACKLOG.md`, never silently dropped.

## Honest gap

G1's "real key" leg needs an actual provider credential. Everything can be built and verified
against the mock server; the real-key leg is the one step that requires the owner. That is a
functional necessity, not a checkpoint — the phase proceeds regardless.

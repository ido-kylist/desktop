# Status

The only coordination surface. If it is not here, it is not agreed.

**Updated:** 2026-11-15 12:21 PST · D9 in review · last gate **G11 passed**

## Phase board

| Phase | Gate | State |
|---|---|---|
| D0 Foundation | G0 | **passed** — `gates/G0.md` |
| D0.5 Rehearsal | R0 | **passed** — `gates/R0.md` |
| D1 Vertical slice | G1 | **passed (mock)** — real-key leg needs a credential |
| D2 History & search | G2 | **passed** — function as written; its perf clauses measured in D9 (`gates/G2.md` addendum, `PERF.md`) |
| D3 Message operations | G3 | **passed** — `gates/G3.md` |
| D6 Assistants · prompts · projects | G6 | **in review** — branch `feat/d6-assistants`, no gate file yet |
| D4–D8 | — | **cut** under the plan's cut line — `BACKLOG.md` (D6 was cut; this slice reintroduces its three pillars) |
| D9 Polish | — | **in review** — `feat/d9-polish`; no gate file yet. Evidence: `tests/e2e/a11y.spec.ts`, `docs/STATES.md`, `PERF.md` |
| D10 Hardening | G10 | evidence in progress |
| D11 Release | G11 | **passed** — `gates/G11.md` |

**Release:** <https://github.com/ido-kylist/desktop/releases/tag/v0.1.0> — `Cleon-0.1.0-arm64.dmg`, unsigned,
`xattr -dr com.apple.quarantine` documented. The installed bundle is tested for a real chat turn,
not just a boot.

## Done

- Enforced branch protection (admins included), secret push protection, 15 PRs all gated by CI.
- Frozen IPC contract at **protocol v9** (v4 at release; D4–D8 each bumped it); sandboxed
  preload, one `require`.
- Schema **v7**, checksummed migrations, FTS5 with `bm25` + `snippet` for threads, `LIKE` for
  the prompt library.
- Secrets in `safeStorage`, fail-closed; key never leaves main.
- Streaming chat, stop, variants with switcher, cost meters, sidebar search, persistence.
- D6: projects (create/rename/archive, thread filter), assistants (system prompt with
  `{{date}}`/`{{time}}`/`{{thread_title}}`/`{{project_name}}`, model and temperature at send
  time), and a searchable prompt library that inserts into the composer.
- D9: axe-core audit on five screens with zero serious/critical violations (and a planted
  violation the audit must catch); keyboard-only send → message → regenerate → variant switch,
  with focus restored across both re-reads; the panel/state matrix in `docs/STATES.md`; a provider-
  unreachable state derived without a protocol bump; and `pnpm perf` measuring what G2 never did.
- **464 unit/integration, 26 e2e, 2 skipped** (the packaged legs need an installed bundle).
- Overnight gap: ~17h lost on 14–15 Nov — the machine stayed awake, but no turns were driven.

## Now

D9 in review as `feat/d9-polish`. Measured on this machine with a 500-thread corpus:
`threads.list` p95 **0.64 ms**, FTS search p95 **6.77 ms**, `chat.thread` p95 **0.17 ms**,
worst `requestAnimationFrame` gap **18.7 ms** while scrolling the sidebar (a proxy, not a
profiler trace). The numbers, the method and the exclusions are in `PERF.md`.

## Not claimed

Performance is measured but only on one machine, and only the database side plus a frame-gap
proxy — there is no profiler trace, and the numbers exclude IPC. No paid provider has been
called. Nothing is signed. Accessibility is verified by axe (which cannot see focus order,
focus traps, or whether a live region is on the right node) and by two keyboard specs; it is
not a conformance audit by a person.

# Status

The only coordination surface. If it is not here, it is not agreed.

**Updated:** 2026-11-15 09:20 PST · phase **D10/D11** · last gates **G2, G3 passed**

## Phase board

| Phase | Gate | State |
|---|---|---|
| D0 Foundation | G0 | **passed** — `gates/G0.md` |
| D0.5 Rehearsal | R0 | **passed** — `gates/R0.md` |
| D1 Vertical slice | G1 | **passed (mock)** — `gates/G1.md`; real-key leg needs a credential |
| D2 History & search | G2 | **passed on function; perf unmeasured** — `gates/G2.md` |
| D3 Message operations | G3 | **passed** — `gates/G3.md`; fork and user-message branching deferred |
| D4–D8 | — | **cut** to `BACKLOG.md` under the plan's own cut line |
| D10 Hardening | G10 | in progress (lite) |
| D11 Release | G11 | next |

## Done

- Repo, CI, enforced branch protection (admins included), secret push protection.
- Frozen IPC contract at **protocol v4**; preload is sandboxed CJS with one `require`.
- Schema **v2** with checksummed migrations; FTS5 search with `bm25` + `snippet`.
- Secrets behind `safeStorage`, fail-closed; key never leaves main.
- Mock inference server, 6 fixtures; 402/429/truncated all mapped to the contract.
- Chat surface: streaming, variants, cost meters, sidebar with server-side search.
- **187 unit/integration tests, 8 e2e passing** (1 skipped: packaged, needs a bundle).
- 14 PRs merged through the protected branch, every one gated by green CI.
- Overnight gap: ~17h lost on 14–15 Nov because no turns were being driven. The machine
  stayed awake the whole time; the driver was the missing piece.

## Now

D10-lite hardening evidence, then D11 release.

## Next

D11: DMG, GitHub Release, release notes, demo script. Cut line is **Sun 20:00**; build freeze
**Mon 02:00**; ship **Mon 09:00**.

## Open questions (owner)

- **Real API key** — closes G1's last leg and makes the demo real. No code change needed.
- **Unsigned DMG** — ships with the documented `xattr` step unless a Developer ID exists.

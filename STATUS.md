# Status

The only coordination surface. If it is not here, it is not agreed.

**Updated:** 2026-11-15 09:55 PST · **v0.1.0 shipped** · last gate **G11 passed**

## Phase board

| Phase | Gate | State |
|---|---|---|
| D0 Foundation | G0 | **passed** — `gates/G0.md` |
| D0.5 Rehearsal | R0 | **passed** — `gates/R0.md` |
| D1 Vertical slice | G1 | **passed (mock)** — real-key leg needs a credential |
| D2 History & search | G2 | **passed on function; perf unmeasured** — `gates/G2.md` |
| D3 Message operations | G3 | **passed** — `gates/G3.md` |
| D4–D8, D9 | — | **cut** under the plan's cut line — `BACKLOG.md` |
| D10 Hardening | G10 | evidence in progress |
| D11 Release | G11 | **passed** — `gates/G11.md` |

**Release:** <https://github.com/ido-kylist/desktop/releases/tag/v0.1.0> — `Cleon-0.1.0-arm64.dmg`, unsigned,
`xattr -dr com.apple.quarantine` documented. The installed bundle is tested for a real chat turn,
not just a boot.

## Done

- Enforced branch protection (admins included), secret push protection, 15 PRs all gated by CI.
- Frozen IPC contract at **protocol v4**; sandboxed preload, one `require`.
- Schema **v2**, checksummed migrations, FTS5 with `bm25` + `snippet`.
- Secrets in `safeStorage`, fail-closed; key never leaves main.
- Streaming chat, stop, variants with switcher, cost meters, sidebar search, persistence.
- **187 unit/integration, 8 e2e, 2 packaged e2e** against the installed DMG.
- Overnight gap: ~17h lost on 14–15 Nov — the machine stayed awake, but no turns were driven.

## Now

D10-lite hardening evidence: commit the v1→v2 migration upgrade test, a redaction proof that
the API key never reaches logs or error payloads, and a security evidence table.

## Not claimed

Performance numbers were never measured. No paid provider has been called. Nothing is signed.

# Status

The only coordination surface. If it is not here, it is not agreed.

**Updated:** 2026-11-15 13:40 PST · **v0.2.0 shipped** · every planned phase delivered, nothing cut

## Phase board

| Phase | Gate | State |
|---|---|---|
| D0 Foundation | G0 | **passed** — `gates/G0.md` |
| D0.5 Rehearsal | R0 | **passed** — `gates/R0.md` |
| P0 Provider settings | P0 | **passed** — key, base URL, model catalogue, verified against the real endpoint |
| D1 Vertical slice | G1 | **passed** — `gates/G1.md` |
| D2 History & search | G2 | **passed with measured numbers** — `gates/G2.md`, `PERF.md` |
| D3 Message operations | G3 | **passed** — `gates/G3.md` |
| D4 Attachments | G4 | **passed** |
| D5 Native shell | G5 | **passed** — launcher, tray, deep links, notifications |
| D6 Assistants/prompts/projects | G6 | **passed** |
| D7 MCP | G7 | **passed** — per-call approval, containment, kill switch |
| D8 Knowledge & artifacts | G8 | **passed** — citations + versioned artifacts |
| D9 Polish | G9 | **passed** — axe clean on 5 screens, keyboard-only, perf measured |
| D10 Hardening | G10 | **passed** — `gates/G10.md`, `docs/SOAK.md` |
| D11 Release | G11 | **passed** — `gates/G11.md`, v0.2.0 published |

**Release:** <https://github.com/ido-kylist/desktop/releases/tag/v0.2.0>
`Cleon-0.2.0-arm64.dmg`, unsigned, `xattr -dr com.apple.quarantine` documented.

## Done

- Enforced branch protection (admins included), secret push protection, 31 PRs merged, every
  one gated by green CI.
- Frozen IPC contract at **protocol v9**; sandboxed preload; schema **v7** with checksummed
  migrations tested from every prior version.
- Secrets in `safeStorage`, fail-closed, canary-tested and mutation-proven across 16 tables.
- Streaming chat with branching and variants, attachments, projects/assistants/prompts,
  MCP with per-call approval, knowledge with citations, versioned artifacts.
- **475 unit/integration, 26 e2e, 2 packaged e2e** against the installed DMG.
- 30-minute soak: 10,825 turns, zero crashes, zero leaked listeners, RSS plateau.

## Not claimed anywhere

Performance numbers are measured and in `PERF.md`. No paid provider turn has been run since
the deployment-prefix finding. Nothing is signed or notarized. MCP isolation is pipes, not an
OS sandbox. All deferrals are in `BACKLOG.md`.

## Owner inputs still open (none blocking)

- A real provider turn to close G1's last leg end to end.
- A Developer ID certificate for a signed DMG.

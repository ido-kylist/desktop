# Owners

One writer per file. Every path has exactly one owner, and ownership is a directory,
never a shared file. If two people need to change one file, the split is wrong and the
contract is missing something.

| Area | Paths | Owner |
|---|---|---|
| **Platform** | `src/main/**`, `src/shared/**` | Lead · Platform |
| — IPC + contracts | `src/shared/**` | Lead · Platform (no worker) |
| — API / SSE | `src/main/api/**` | Worker · API |
| — DB / migrations | `src/main/db/**` | Worker · DB |
| **Product** | `src/renderer/**` | Lead · Product |
| — chat surface | `src/renderer/src/features/chat/**` | Worker · Chat |
| — shell & settings | `src/renderer/src/features/shell/**` | Worker · Shell |
| **Quality** | `tests/**`, `scripts/**`, `.github/**`, `build/**` | Lead · Quality |
| — fixtures / mock | `mock/**`, `tests/fixtures/**` | Worker · Fixtures |
| — e2e / CI | `tests/e2e/**`, `.github/**` | Worker · E2E |
| **Docs** | `docs/**`, `README.md`, `AGENTS.md`, `BACKLOG.md` | Orchestrator |

## Reviewers and verifier

- **Reviewer A** — adversarial review of platform changes.
- **Reviewer B** — adversarial review of product changes.
- **Verifier** — runs every gate. Authors never verify their own work.

## Escalation

Contracts (`src/shared/**`) are frozen at D0. A change there requires the orchestrator,
a `PROTOCOL_VERSION` bump, and both sides updated in the same PR.

# Decisions

Dated, with the reasoning that made them. A decision without a reason is a rumour.

## D0 — stack pins

The plan pins exact versions (Rev 4 §2.5). All were verified to exist on npm
before install, rather than trusted:

```
electron 45.3.2 · electron-vite 6.0.0 · electron-builder 26.18.0
better-sqlite3 13.1.1 · drizzle-orm 0.45.4 · zod 4.6.7 · zustand 5.1.0
@tanstack/react-query 5.107.1 · react 19.1.10 · typescript 5.9.3
biome (@biomejs/biome) 2.3.11 · vitest 5.1.0 · @playwright/test 1.65.1
```

`biome` is published as `@biomejs/biome`; the plan's shorthand would not have installed.

## D0 — the preload cannot import zod

**Problem.** `electron-vite` externalises dependencies for the preload target even
without `externalizeDepsPlugin`, and a sandboxed preload's `require` is limited to
`electron` plus a few builtins. Importing the contract (which imports zod) therefore
produced `require("zod")` in the bundle and the bridge silently never appeared —
the window rendered, `window.cleon` was `undefined`, and nothing threw anywhere
visible.

**Decision.** Split the contract in two:

- `src/shared/channels.ts` — no imports at all: `PROTOCOL_VERSION`, `CHANNEL_NAMES`, `isChannelName`.
- `src/shared/ipc-contract.ts` — imports zod, holds the schemas, and re-exports the channels module.

`ipc-contract.ts` declares `contracts` with `satisfies Record<ChannelName, Contract>`, so a
name without a schema (or a schema without a name) is a compile error. The preload
imports only `channels.ts`, and the bundle is 578 bytes with exactly one require.

**Consequence.** The preload stays sandboxable. Any future preload need must be
satisfiable without zod, or it belongs in main behind a channel.

## D0 — migrations are inline and checksummed at runtime

`drizzle-kit` cannot express FTS5 virtual tables or their triggers, so the migration
that matters most cannot be generated. Rather than commit a generated migration and
a hand-written one that disagree, the SQL lives in `src/main/db/migrations.ts` and is
checksummed (SHA-256, first 32 hex chars) into `schema_migrations` on apply. A mutated
migration is a hard startup failure.

The Drizzle schema in `src/main/db/schema.ts` remains the source of truth for queries.

## D0 — better-sqlite3 needs no Electron rebuild

`better-sqlite3` 13.1.1 ships N-API bindings, so the module built against Node 24 loads
unchanged inside Electron 45. Verified, not assumed: the e2e test asserts the app reads
`schemaVersion: 1` and `fts5: true` from a real database inside the packaged runtime.

## D0 — unsigned DMG

There is no Developer ID certificate on this machine. The DMG is built with
`identity: null` and the README documents the `xattr -dr com.apple.quarantine` step.
Faking a signature was never an option.

## D0 — branch protection (resolved)

The repo was private on the free plan, where both `PUT /branches/main/protection` and
`POST /rulesets` return **403**. The owner made the repository public, which unblocked it.

Applied and verified:

| Setting | Value |
|---|---|
| Required status check | `typecheck · lint · build · test · e2e` (strict) |
| Enforce for admins | **true** — the owner cannot bypass either |
| Force pushes | blocked |
| Branch deletion | blocked |
| Conversation resolution | required before merge |
| Collaborators with push | `ido-kylist` only |

**Proof, not configuration:** a direct `git push origin HEAD:main` was attempted and
rejected by the remote —

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Required status check "typecheck · lint · build · test · e2e" is expected.
```

A public repository means anyone may *read* and *fork* it; it does not mean anyone may
*write* to it. Write access is the single collaborator above, and even that collaborator
cannot push to `main` directly.

Also enabled, because the repo is public and the product will handle API keys: secret
scanning and **push protection**, so a credential cannot be committed at all.

## D1 — protocol v3, and why the read channel exists

`chat.thread` was added for one reason: G1 requires "relaunch restores", which needs a read
path the renderer can call. It returns a thread and its messages and nothing else — no
pagination, no search. D2 owns those, and a narrower contract now is cheaper than widening one
later. Protocol went 2 → 3 for this single channel; versions stay monotonic.

## D1 — markdown is hand-rolled, deliberately

The plan pins streamdown, but adding a dependency requires a decision entry and this slice had
no room to evaluate a renderer. The subset implemented — fenced code, inline code, bold,
italic, links, lists, paragraphs — is built as React elements, with **no**
`dangerouslySetInnerHTML` anywhere in the renderer. An XSS payload
(`<img src=x onerror=alert(1)>`) is unit-tested to render as escaped text.
Replacing it with a real parser is in `BACKLOG.md`.

## D1 — "retry" is a new turn, not a regeneration

The frozen contract has `chat.send` and `chat.stop`; it has no regenerate primitive. So retry
literally re-sends the same user text, which persists a second user message. That duplication
is the honest consequence of not having the primitive, and it is recorded rather than hidden
behind a UI that pretends to edit history. A `chat.regenerate` channel belongs with D3's
branch tree, where variants already exist.

## D1 — `CLEON_USER_DATA` exists for tests

`app.setPath("userData", ...)` when the env var is set. Without it, an e2e that proves
"relaunch restores" would either pollute the developer's real database or require deleting it.
A test hook that changes where data lives is preferable to tests that pretend to be isolated.




## P0 — verification against the real Sciforium endpoint

Tested the shipped code path against `https://api.sciforium.com` with the owner's key
(six requests total, nothing bursty). Verified: non-streaming 200 in 0.5 s, SSE streaming
with `finish_reason: stop` then `[DONE]`, `/v1/models` returning 14+ models, `secrets.setKey`
storing under `safeStorage` (`••••Yz44`), settings persisting, and the app's own IPC
`chat.send` reaching the provider.

**One blocking quirk, found before the owner could hit it:** the `/v1/models` catalog returns
*bare* ids (`deepseek-ai/DeepSeek-V4.1-Flash-1017`), but `/v1/chat/completions` rejects them:

```
400 INVALID_DEPLOYMENT_TARGET
"Model must be prefixed with \"/deployments/{serverless|poolId}/\"; the bare model format is no longer supported."
```

`/deployments/serverless/deepseek-ai/DeepSeek-V4.1-Flash-1017` works. So on this provider the
usable model id carries a deployment prefix that the catalog does not advertise. The app
surfaced the provider's message verbatim, which is the only reason this took one step to
diagnose — the error taxonomy did its job.

**Follow-up:** the Settings model field must accept a typed id (not only the catalog select),
and `models.list` should say that catalog ids may need a deployment prefix on this provider.
Recorded in `BACKLOG.md`; not a release blocker, because the user can paste the working id.

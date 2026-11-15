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

## D6 — protocol v7, schema v5: projects, assistants, prompts

**What changed.** Eleven channels added (`projects.list/create/update`,
`assistants.list/create/update/delete`, `prompts.list/create/update/delete`), four existing
ones widened: `chat.send` gained `assistantId` and `projectId` and **lost its required
`model`** (an assistant can supply it), `chat.thread` reports the thread's `projectId` and
`assistantId`, and `threads.list` gained a `projectId` filter plus a per-row `projectId`.
`PROTOCOL_VERSION` 6 → 7. Migration 5 adds `projects`, `assistants`, `prompts`,
`threads.assistant_id` and its index.

**No new dependency.** Nothing in this slice needed one: search is `LIKE`, the clock is
`Date`, and the UI is the components that were already there.

**`threads.project_id` already had its index.** Migration 1 created `threads_project_idx`
and the Drizzle schema already declared it, so migration 5 adds only the index the new
column needs (`threads_assistant_idx`). Creating a second index on the same column would
have been a write cost paid for nothing.

**No foreign keys on `threads.project_id` / `threads.assistant_id`.** Same trade as
`active_leaf_id`: both are hints for the next turn. A project archived or an assistant
deleted while a thread still names it must not make the thread unreadable, and SQLite
cannot add a foreign key to an existing column without a table rebuild.

**`assistants.delete` archives; `prompts.delete` deletes.** A thread carries the id of the
assistant it was last sent with, so removing the row would leave a dangling pointer and
regeneration would lose the system prompt. A prompt is text with nothing pointing at it.

**Prompt search is `LIKE`, not FTS5.** The brief allowed either. `LIKE` over
`lower(title)`/`lower(body)` needs no virtual table and no three triggers, and a prompt
library is tens of rows, not thousands of messages. Tokens are ANDed, and `%`/`_`/`\` are
escaped with an explicit `ESCAPE '\'`, so searching for `50%` finds the prompt that says
"50%" instead of every prompt. Exact is in the test, not in the intent.

**Prompt `{{date}}` and `{{time}}` are UTC.** Everything else this app stores and compares
is UTC; a formatter that quietly used the machine's zone would expand the same prompt
differently on two machines, and the unit test could only assert around it. A local-time
variant needs a timezone setting to be honest, and is in `BACKLOG.md`.

**A variable with no value stays literal.** `{{project_name}}` in a thread with no project
expands to `{{project_name}}`, not to an empty string. "Never silently blanked" is the rule
for unknown names; a known name with nothing to say is the same failure mode, and a prompt
that reads "Project: " is worse than one that shows what it could not fill in.

**A project is assigned at creation, never on send.** `chat.send` reads `projectId` only
when `threadId` is null. Re-filing an existing conversation on every turn would let the
sidebar's filter move threads the user never touched. Moving an existing thread needs a
`threads.update` field and an affordance, and is in `BACKLOG.md` rather than half-built.

**The composer omits `model` when an assistant is picked.** Two authorities for one value
is a bug waiting for a disagreement: the assistant's model is used, so the model select is
replaced by a statement of what will be sent. When the assistant's row is not on screen
yet (loading, or archived), the statement says where the value comes from instead of
guessing an id.

**The thread count is a `GROUP BY`, not a correlated subquery.** The first version counted
per project with a subquery in the select, and it silently returned 0 for every project:
drizzle renders a bare column reference as `"id"`, and inside a subquery over `threads`,
`"id"` resolves to `threads.id`, so the correlated reference compared a project id with a
thread id. One grouped aggregate and a merge in main has no such ambiguity and is one scan.

**`{{date}}` is expanded at send time from the injected clock**, through
`GenerationService`'s existing `clock` dependency. The unit test drives the pure function
with a `Date`; the integration test freezes the service's clock. Neither mocks a global.

**One existing test had to change, and it is not a weakened gate.**
`tests/integration/attachments.spec.ts` asserted `MIGRATIONS.at(-1).version === 4`. That
statement is false by construction once migration 5 exists, and its real claim is
"migration 4 is applied", so it now asserts `>= 4` and keeps the `attachments` column
assertion that was the substance of the test.

## D7 — MCP: stdio, per-call approvals, and a child that cannot hurt the app

**Transport is stdio with newline-delimited JSON-RPC 2.0.** No SSE, no HTTP. That is MCP's
own stdio framing, and it is the only transport a locally installed server is normally
launched with; adding a second one would be a second set of failure modes with nothing yet
asking for it. Frames are one JSON object per line each way, and the framing is tested
independently of any child process (`tests/unit/jsonrpc.spec.ts`) so a rule like "two
messages in one chunk" is proven for its own sake rather than by accident.

**Protocol v8, seven channels, and no channel that executes a tool directly.**
`mcp.requestToolCall` records an intent and returns an approval id; `mcp.resolveApproval`
is the only path to `tools/call`, and it only calls when `allow` is true. There is no
"remember this" and no allow-list: the brief for this phase asked for per-call approval,
and a per-call gate is the only version whose default is deny. A second resolve of the
same approval is `CONFLICT`, not a second execution, because the claim is a conditional
`UPDATE … WHERE status = 'pending'` plus an in-process set of in-flight ids.

**Deny never touches the child.** The integration test proves it with a tool that would
kill the server: `crash` exits the process, so a denial that reached the child could not be
mistaken for one that did not — the status after a denied `crash` is still `ready`.

**A request starts nothing.** `mcp.requestToolCall` does not spawn and does not check that
the tool exists. Spawning is what `tools/list` and `resolveApproval(allow)` do; a server
that is never used never runs, and a request can be made against a server that is not
running. Whether the tool exists is the server's answer at execution time, recorded as a
`failed` approval with the server's own words.

**A crashed server is not restarted implicitly.** Its exit is news the user has to see, and
a silent restart would recreate the tools of a process that died without saying why.
`killServer` then `listTools` is the deliberate restart, and the error says so. The last
line of stderr is kept for display: "it crashed" with no reason is a support ticket, not a
state anyone can act on.

**Kill is SIGTERM, then SIGKILL after two seconds, and the wait is bounded.** A child that
ignores both is not a thing the OS allows, but a stream that never reports the exit would
hang an IPC call forever, so the wait resolves on a timer regardless. On quit the signal is
sent synchronously: a `before-quit` handler that awaits can be cut short by the app going
away mid-await, and a spawned server that outlives its parent is a stray process nobody
knows to stop.

**Arguments are never logged, at any level.** They are the one part of this surface that
can carry a token or a password. The logs carry the server id, the tool name and a byte
count — enough to tell "empty" from "something was passed", and nothing a log reader can
replay. The API key rule from invariant 2 applies to tool arguments for the same reason.

**A tool result with `isError: true` is `executed`, not `failed`.** The call completed; the
tool's own result says the work failed. Collapsing the two would throw away the tool's
words and make the status mean two different things. `failed` is reserved for the call not
completing — a timeout, a crash, a JSON-RPC error — and carries the reason.

**Server-initiated requests are refused (-32601), not ignored.** This client advertises no
capabilities, so a compliant server will not send one; a non-compliant one should not be
left waiting on a reply that will never come. Notifications are ignored, and the tests say
so explicitly rather than leaving the reader to guess.

**Removing a server removes its approvals (`ON DELETE CASCADE`).** A pending call on a
server that no longer exists has nowhere to go, and offering a button that cannot work is
worse than forgetting the row. A durable audit that outlives the server it audits needs a
denormalised server name to stay readable; that is a design change and is in `BACKLOG.md`.

**`env_json` and `enabled` exist in schema v6 with nothing writing them.** They are the two
fields a "disable without removing" and a "set an environment variable" affordance both
need, and a boolean column added later is a migration for nothing. Neither is exposed by
any channel in this phase, and both defaults are the safe ones: inherit no environment,
and enabled.

**The panel's approval records are this window's memory.** They are persisted in
`mcp_approvals` (the integration test reads the row for every outcome), but the contract
declares no channel to list them back, so a relaunch forgets what the panel was showing.
Reading history back is in `BACKLOG.md` rather than faked behind a list that would be a
subset of the truth. Status is likewise not pushed: the panel re-reads on every action and
on a Refresh button, which is honest about being a read.

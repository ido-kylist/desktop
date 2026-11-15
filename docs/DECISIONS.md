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

## D8 — knowledge and versioned artifacts: retrieval, citations, and an append-only record

**Protocol 8 → 9, schema 6 → 7.** Eight channels added: `kb.addDocument`, `kb.listDocuments`,
`kb.deleteDocument`, `kb.search`, `kb.readChunk`, and `artifacts.list`, `artifacts.get`,
`artifacts.save`. Three widened: `chat.send` gained `useKnowledge`, `documentIds` and a
`citations` response field, `chat.thread` reports `citations` per message, and
`settings.get` / `settings.set` gained `embeddingModel`. Migration 7 adds `documents`,
`chunks`, `artifacts`, `artifact_versions`, and `messages.citations_json`.

**Deviations from the brief, and why.**

1. **A fifth channel, `kb.readChunk`.** The brief fixes a citation at `{chunkId, documentId,
   documentTitle, ordinal}` and also asks chips to "expand to the source chunk text". Those
   two cannot both hold without a way to read a chunk by id. The alternatives were worse:
   adding `text` to the persisted citation duplicates up to 800 characters per citation, five
   per message, on a row that is replayed on every `chat.thread`; and re-running the query
   would answer a different question than the one the answer was written for. So the citation
   stays a pointer and a chip fetches its text when it is opened — which also means a chunk
   that has since been deleted reports NOT_FOUND instead of showing text that no longer
   exists anywhere.

2. **`chat.send` answers with `citations`.** The brief puts the citation list on
   `chat.thread`, which is what a relaunch needs. Without the field on the send response the
   chips would only appear after a reload — a live turn would look ungrounded while the row
   under it said otherwise. The field is optional, so a turn with no knowledge is wire-identical
   to before.

3. **`messages.citations_json` is a column the brief's schema list did not include.** The
   brief requires the citation list to be persisted on the assistant message and its table
   list has no place for it. `content_blocks` was the other candidate, but its `kind` CHECK
   has no member for a citation and adding one is a table rebuild. A nullable JSON column on
   `messages` is the smallest honest change: it is a value of the message, read whole with
   it, and never queried into — the same trade `mcp_servers.args_json` makes.

4. **PDFs are refused, not indexed.** `kindForFilename` classifies `.pdf` as a document, but
   its bytes are compressed streams and glyph indices. Decoding them as UTF-8 produces
   mojibake that chunks, embeds and retrieves — all of it wrong, none of it detectable from
   the result. Honest extraction needs a parser or OCR, neither of which is in the dependency
   budget, so `.txt` and `.md` are indexable and a PDF is refused by name with
   `reason: "not_readable_text"`. The caps and the extension table are still the attachment
   module's (`isTooMany`, `isTooLarge`, `kindForFilename`), because a file this app will not
   attach must not be a file it silently indexes.

**Search is a linear scan, and that is the decision.** Retrieval reads every chunk whose
vector is the same width as the query's, computes cosine, sorts, and takes k. It is O(n) in
the corpus and it is the right complexity for a local knowledge base: tens of documents, a few
thousand chunks, a scan measured in milliseconds. An ANN index (HNSW, IVF, `sqlite-vec`) is a
second structure to build, persist, invalidate and explain, and it is **explicitly out of
scope** for this slice. The seam is one function — `listChunksForSearch` — which is where an
index would be introduced.

**Vectors are normalized float32 in a BLOB, with the width stored beside them.** `dim` is a
column rather than `byteLength / 4` because an empty or truncated blob must not read as a
legal zero-width vector, and because a corpus embedded by one model has to be recognisable as
incomparable with a query embedded by another. Search filters on `dim`; when there are chunks
but none of the query's width, it is a CONFLICT naming the mismatch rather than an empty
result. "Your documents do not mention that" and "your documents were embedded with a
different model" are different answers, and only the second has a fix.

**Embeddings go through the configured provider**, `POST {baseUrl}/v1/embeddings`, with the
model from `settings.embedding_model` (default `text-embedding-3-small`). Same base URL and
key as chat, resolved through the same `inferenceConfig()`: an embedding endpoint is part of
the same provider, and two resolvers would eventually disagree about which endpoint is
configured. Batches are 64 strings per request — the endpoint takes an array, so a forty-chunk
document is one request rather than forty. Response order is restored from each item's `index`
when the provider sends one: the specification allows any order, and a permuted batch would
attach every chunk to the wrong vector, which reads as "search is bad" and is very hard to see.

**Retrieval happens before the turn is written.** A knowledge-backed `chat.send` embeds the
query and retrieves first, then persists the messages. An embedding provider that is down,
misconfigured or rate-limited is therefore a refusal with nothing written, rather than a turn
on screen whose answer was not the one that was asked for. The retrieval spec (the brief's
decision 6) asked for the chunks "prepended to the system prompt": they are their own system
message in front of the assistant's, so each stays legible and neither swallows the other's
formatting, and the markers `[1]…[5]` are in the same order as the persisted citation list.

**k = 5.** Five excerpts is small enough to read and large enough to answer from; it is
`TOP_K` in `knowledge/service.ts` and the one number that would move first if answers look
ungrounded or the prompt grows too fast.

**`generate` does not retrieve.** A regenerated answer is a second answer to the same question
with the same material; re-running retrieval against a corpus the user may have edited since
would produce a "variant" that answers a different question. The original message's citations
are left exactly as they were.

**Chunking: 800 characters, 120 overlap, paragraphs first.** 800 characters is roughly 200
tokens of English prose — two or three paragraphs, or one dense one. The overlap exists so a
sentence that straddles a boundary appears whole in at least one window; without it "the total
is 42" can split into "the total is" and "42" and neither retrieves well. Paragraphs are the
preferred cut because prose is written in them; a single paragraph larger than the window is
cut by character with the overlap applied. Lengths and cuts are in **code points**, not UTF-16
units: `text.length` counts a surrogate pair as two, so a boundary computed on it can land
between the halves of one emoji and produce two unpaired surrogates — the chunk, once embedded,
would then be a different string than the one on disk.

**`source_path` is unique.** Indexing the same file twice is the same text and a second bill
from the embedding provider, so `kb.addDocument` reports the existing row as CONFLICT. An
atomic replace (delete + insert in one transaction) is the affordance missing here and is in
`BACKLOG.md`.

**A batch is all or nothing.** Every file is validated, copied, chunked and embedded before
any row is written, and the documents are inserted in one transaction. A batch that indexed
three of five files and then failed would leave the panel saying "added 3" with no way to tell
which two are missing — and a document whose copy was cleaned up would be a row that lists but
never searches. When anything fails, the copies are removed; the list of copies is tracked
separately from the sources because the read that can fail happens *after* the copy, and a
cleanup list that only learned about a copy after the read left exactly that file on disk
(caught by `tests/integration/knowledge.spec.ts` before the first commit).

**Artifacts: a save appends.** `artifacts.current_version` names the newest row in
`artifact_versions`, and nothing in the codebase updates or deletes a version row. That is what
makes a version switcher a real affordance rather than a re-reading of one row. The bump is a
single conditional `UPDATE … WHERE id = ? AND thread_id = ? AND current_version = ?` with
`.returning()`: a preceding SELECT followed by an unconditional UPDATE is the classic lost
update, and this cannot lose one. When the update matches nothing, a second read says which
guard failed — NOT_FOUND for a wrong address, CONFLICT when the version moved and a retry is
reasonable. The title travels with the save, because it is part of what the user edited.

**An artifact belongs to a thread, and the thread is part of the address.** Saving with another
thread's id is NOT_FOUND rather than CONFLICT: CONFLICT would confirm the id exists somewhere.
A soft-deleted thread still accepts a save — the rows are the user's and the thread is only
hidden from the sidebar — and the cascade from a really deleted thread takes its artifacts with
it.

**Ordering uses `rowid` as the tiebreaker.** Artifacts and documents are listed newest first by
`created_at DESC, rowid DESC`. Two rows created in the same millisecond are the normal case
(a batch add, a test), and ordering them by a random uuid makes the list reorder itself between
two reads. A test that asserted "newest first" caught this on the first run.

**A citation list that will not parse reads as none.** `citations_json` is written by this
build, but a row from a newer build could carry a shape this one does not know, and a whole
thread must not fail to load over one bad annotation. Anything that is not a list of four-field
objects is dropped; the message still renders.

**The renderer's knowledge toggle is per-turn state, not a setting.** It is not persisted, it is
sent explicitly on every `chat.send` (including `false`), and it is disabled while a turn is in
flight. A mode that survived a relaunch would silently keep searching a corpus the user forgot
about, and a flag read mid-stream would describe a turn that had already started with a
different value.

**One existing test changed, and it is not a weakened gate.** `tests/integration/settings.spec.ts`
and `tests/unit/settings-form.spec.ts` asserted exact shapes of the settings record, which now
has a third key. Their claims — "a blank value is a clear", "the form drops a null base URL" —
are unchanged; the fixtures gained `embeddingModel`, and a new case covers the new key's own
round trip and clear. `tests/integration/migration-upgrade.spec.ts` gained an assertion that the
v7 tables and `messages.citations_json` exist after upgrading a real v1 database, because
`ALTER TABLE` on a legacy table is the one migration shape an existing database can reject.

**No new dependency.** Chunking is a function over a string, cosine is a loop, the vector codec is
`Buffer`, and the UI is components that were already there.

## D9 — axe-core, and the states and measurements behind it

**One dependency, and only one: `axe-core` 4.14.0 (dev).** The brief allowed it, and the
alternative was worse: every claim about labels, roles and contrast would be an assertion
by the person who wrote the markup, verified by nobody. axe runs the WCAG 2.0/2.1 A+AA rule
sets plus its own best-practice rules in the real renderer on the real build
(`tests/e2e/a11y.spec.ts`), and the gate is zero serious/critical violations on five screens.
It is a devDependency: nothing about it ships.

**axe is injected without weakening the CSP.** The renderer ships `script-src 'self'`, so
`page.addScriptTag` — which appends an inline `<script>` — is refused by Chromium. That was
verified, not assumed: the first attempt failed with the CSP violation in the runner log. The
choice was between loosening the policy for a test and loading axe another way. Loosening it
was not an option: invariant 1 and the CSP are the reason a model's output cannot execute.
So axe is installed with `addInitScript`, which Playwright delivers through the debugger
protocol before the document's own scripts and is therefore outside the page's CSP. The cost
is one reload before the audit, which is safe in a local-first app that restores the selected
thread from storage.

**The audit has a negative control.** `a11y.spec.ts` plants an image with no alt and a link
with no name and asserts axe reports `image-alt` and `link-name`. Without it, a typo in the
axe install would turn four green audits into a green no-op, and nobody would know.

**What axe found, and was fixed rather than suppressed.** Three real findings, all moderate:
`landmark-one-main` on Settings (the screen was a `<section>`, so the document had no `main`
landmark in that view — it is now `<main>`), and `landmark-no-duplicate-banner` plus
`landmark-unique` on the panels (a `<header class="library-head">` inside a
`<section role="dialog">` is counted as a second banner by axe — the panel title bars are
`<div>`s now, and no AT has to reconcile two banners). The rest of the work was what axe
cannot see: a single visible `:focus-visible` ring (seven text inputs, across five rules, used to
suppress the outline and replace it with a 1.3:1 border tint), focus into and out of modals, and a live region on
the streaming answer's body.

**The live region is on the answer, not on the list.** `aria-live="polite"` and
`aria-atomic="false"` sit on the one assistant body whose generation is live, for as long
as it is live. A region around the transcript would re-announce every earlier turn on each
token; a permanent region would announce a whole restored thread on open. Both are tested:
exactly one polite region during a stream, on `.md`, and none afterwards.

**"Provider unreachable" is derived, not a new error code.** The contract's closed set has
no `OFFLINE`, and adding one is a protocol bump for a fact the payload already carries:
`httpError()` always attaches `details.status` (the provider answered and refused), while a
transport failure attaches `details.reason` and no status. `isProviderUnreachable()` encodes
that rule once and every surface uses it. Matching on message text was the other candidate
and would break the first time a message is reworded.

**Focus is restored after a re-render, because the alternative is losing the user's place.**
A variant switch and a regenerate both re-read the thread, and the re-read replaces the
message row — the button that was pressed is unmounted and focus falls to `document.body`.
`focusVariantControl()` puts it back on the newly enabled arrow, guarded so it only runs when
focus was actually lost (inside the transcript or on the body) and never steals the caret out
of the composer. The keyboard spec asserts the restore, and was checked to fail without it.

**The perf harness compiles the database layer instead of copying its SQL.**
`pnpm perf` runs `node scripts/perf/measure.mjs`, which `tsc`-compiles
`src/main/db/**` + `src/main/errors.ts` to `scripts/perf/.build/` with a dedicated tsconfig
and then imports it. Plain `node` cannot import `repo.ts` from a module that addresses its
neighbours as `./client.js`, and the alternatives were both wrong: a second implementation of
the queries would measure code that ships nowhere, and a new runtime (tsx/ts-node) is a
dependency for a script. `tsc` is already there. The build output is gitignored.

**Why `threads.list` and not the whole IPC round trip.** The measurement calls the repository
function, which is what the handler calls; it does not go through Electron's IPC, so it
excludes the serialise/postMessage/deserialise cost. That is deliberate — the gate's clause
is about the query at 500 threads — but it is a real exclusion and it is written down in
`PERF.md` rather than left for a reader to assume otherwise.

**Why the frame number is called a proxy in every sentence that mentions it.** G2 says
"60 fps". Proving that needs a profiler trace; this harness samples `requestAnimationFrame`
gaps while the sidebar scrolls and reports the worst one. It supports "no frame took longer
than N ms", not "the app runs at 60 fps", and the difference is stated where the number is.

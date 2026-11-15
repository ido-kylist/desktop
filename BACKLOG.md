# Backlog

Work consciously deferred. Nothing here is a surprise in a demo, because it is written down.

## Deferred from D0

- **App icon.** electron-builder used the default Electron icon. A real icon set
  (`build/icon.icns`) belongs with D9 polish.
- **Code signing / notarization.** No Developer ID certificate on this machine. The DMG is
  unsigned by design; the README documents the quarantine step. Revisit in D11 when
  credentials may exist.
- **Drizzle-generated migrations.** FTS5 cannot be expressed by drizzle-kit, so migrations are
  hand-written and checksummed at runtime. Revisit only if drizzle-kit gains virtual-table support.
- **Renderer test harness.** No component tests yet; D1 introduces the chat surface and the
  first component-level tests with it.

## Deferred from D1

- **Real markdown renderer.** The subset in `src/renderer/src/lib/markdown.ts` handles code,
  emphasis, links, lists and paragraphs. It has no tables, images, headings, math or nested
  lists. Replace with a real parser (streamdown or remark) once a dependency decision is made.
- **Reasoning and tool calls are not persisted.** `content_blocks` exists in the schema and is
  unused; a restored turn is text only, so reasoning collapses and tool rows vanish on relaunch.
  Belongs with D4's content-block work.
- **No model picker.** The composer lists the six mock ids because there is no `models` table
  yet. D6 owns the catalog; the picker must read from it and drop the mock list.
- **`retryAfterMs` does not survive a relaunch.** Only `error_code` is persisted, so a restored
  `RATE_LIMITED` shows the code with no countdown. Needs a persisted error payload.
- **`toolResult` rows are unreachable live.** D1b emits `toolCall` but nothing executes tools, so
  `toolResult` is covered by unit tests only. D7 (MCP) makes it reachable.
- **The D0 diagnostics strip survives** only because `tests/e2e/boot.spec.ts` asserts it. Retire
  both together.
- **`chat.regenerate` does not exist.** Retry is a new turn with the same text and therefore
  duplicates the user message. Belongs with D3's branch tree.
- **Real-key leg of G1.** The stream → quit → relaunch path is proven against the mock; a real
  provider needs an owner credential. No code change required.

## Deferred from D2/D3

- **No performance measurement.** G2's gate is "500 threads · p95 < 100 ms · 60 fps". The
  implementation is O(visible) with server-side pagination, but nothing was timed. Needs a
  `scripts/perf` harness that seeds 500 threads and records real numbers in `PERF.md`.
- **Fork and user-message branching.** `chat.regenerate` creates assistant siblings; editing a
  user message into a branch and forking a subtree at an arbitrary message are not implemented.
- **Migration 1 → 2 upgrade is verified but not tested.** The upgrade was proven by hand against
  a real v1 database; `openDatabase` is a module singleton, so encoding it needs a small seam.
- **`regenerate` model fallback.** `messages.model` is nullable while `generations.model` is not,
  so a model-less row regenerates with `""`. Every row `chat.send` writes has a model.
- **No title generation.** Every new thread is literally "New thread" until renamed.
- **Row actions and Regenerate have no committed tests.** Exercised by hand in a throwaway
  script (rename/pin/archive/delete, variant switching, meters), not in the suite.
- **`parseSnippet`, `formatCost`, `relativeTime`, `sumUsage` are unit-untested** — the three
  mandated test files did not cover them.
- **Store latency:** a `usage` event arriving *after* `done` would re-arm `streaming`. Unreachable
  today because main emits usage first; worth a guard when D7 adds usage from tool calls.



## Deferred from D6

- **No way to move an existing thread into a project.** `chat.send` files a *new* thread
  under `projectId`; filing an old one needs a `threads.update` field and a row affordance,
  and the row is a fixed-height windowed list where a new control is a layout change.
- **Archived projects and assistants are unreachable in the UI.** Archiving hides them
  (which is the point), and there is no "show archived" view to restore one. Main supports
  `assistants.list { includeArchived: true }` and `assistants.update { archived: false }`
  already; only the surface is missing.
- **Prompt search is `LIKE`, not FTS5.** Fine for tens of rows; a large library wants
  `prompts_fts` with `bm25` and `snippet`, which is a virtual table and three triggers.
- **`{{date}}` / `{{time}}` are UTC.** A local-time expansion needs a timezone setting so
  the same prompt cannot mean two different days in two places.
- **Assistants have no per-thread lock.** The picker can change the assistant of an
  existing thread mid-conversation, and the thread records the latest one — so a thread
  sent with two different assistants regenerates under the most recent. A per-message
  assistant id is the honest fix.
- **No component-level tests for the D6 surfaces.** The four catalog states are exercised
  through the pure `buildCatalog`/`describeCatalogState` and end to end, not at the
  component level; there is still no renderer test harness (deferred since D0).
- **The prompt library does not manage folders or tags**, and insertion always appends to
  the end of the composer rather than at the caret.

## Deferred from D7

- **stdio is the only transport.** No HTTP and no SSE. That is what a locally installed
  server is launched with and what this phase asked for; a second transport is a second
  set of failure modes, and nothing yet asks for it.
- **No approval history channel.** Every outcome is written to `mcp_approvals` and the
  integration test reads it there, but the contract declares no `mcp.listApprovals`, so the
  panel's records are this window's memory and a relaunch forgets them. A "Recent calls"
  section wants that channel first.
- **No "remember this" and no allow-list.** Deliberate for this phase: every call asks
  again. A per-tool allow-list is a security feature that needs its own review, and a
  half-built one ("always allow this session") is worse than none.
- **Server status is not pushed.** A crash while the panel is idle is visible on the next
  read — any action, or the Refresh button — not the moment it happens. A push channel
  (`mcp:event`, in the shape of `generation:event`) is the honest fix.
- **`env_json` and `enabled` are stored but have no channel.** Both default to the safe
  value and are documented in migration 6; the affordances are not built.
- **Removing a server deletes its approvals.** `ON DELETE CASCADE`: there is no audit trail
  that outlives the server it audits. Keeping one needs a denormalised server name and a
  decision about how long a refused call is worth remembering.
- **Tool arguments are not validated against the server's `inputSchema`.** Main passes an
  object through and the server decides; enforcing a schema this app did not write would
  mean trusting it as a validator. The panel refuses anything that is not a JSON object,
  which is where the useful error message lives.
- **No notifications are subscribed.** `notifications/tools/list_changed` and
  `notifications/message` are ignored, so a server whose tools change while it runs keeps
  showing the list from the last read.
- **No concurrency limit.** Every server is one process and every server can be running at
  once; ten servers is ten idle node processes. A cap (or an idle timeout) wants a decision
  about which one to evict.
- **No component-level tests for the MCP panel.** The approval card's blocking behaviour is
  proven end to end in `tests/e2e/mcp.spec.ts` and the gate itself in the integration suite;
  the panel's own states (loading, error, empty) have no renderer harness, as with D6.

## D8 — knowledge and versioned artifacts

- **No ANN index; retrieval is a linear scan.** Every chunk's vector is read, scored and
  sorted in main. That is O(n) and correct for a local corpus of a few thousand chunks; an
  ANN index (HNSW, IVF, or `sqlite-vec`) is a second structure to build, persist, invalidate
  and explain, and it is explicitly out of scope for this slice. The upgrade point is
  `KnowledgeService.search`: it is the only caller of `listChunksForSearch`.
- **PDFs are refused, not indexed.** A PDF's bytes are compressed streams, and honest text
  extraction needs a parser or OCR — neither is in this slice's dependency budget. The file
  is refused by name with `reason: "not_readable_text"`, and the panel says so. `docx`,
  `html` and `rtf` are in the same position.
- **Re-adding a file is a CONFLICT, not a re-index.** The `source_path` unique index refuses
  the duplicate, so an edited document must be removed first. Atomic replacement
  (delete + insert in one transaction) is the affordance missing here, and it wants a
  decision about what happens to citations that point into the old chunks.
- **No dedupe of content.** Two files with identical text are two documents, two copies and
  two embedding bills. A content hash column would fix it, and that is a schema change with
  a backfill.
- **Citations are metadata only; the text is read on demand.** `chat.thread` returns four
  fields per citation and `kb.readChunk` fetches the text when a chip expands. A deleted
  document therefore leaves a chip that reports NOT_FOUND rather than a stale copy of text
  that no longer exists anywhere else.
- **`kb.search` has no `documentIds`.** The answer path narrows retrieval inside `chat.send`,
  which is where the contract puts the scope. The panel searches everything, and a per-document
  scope in the preview wants its own contract field.
- **Knowledge is a per-turn toggle, not a setting.** It is not persisted, so a relaunch turns
  it off. That is deliberate — a mode nobody remembers enabling is worse than a checkbox —
  but a "default on for this thread" wants a column.
- **Artifacts are not shown inline in the transcript.** They are a panel: list, versions,
  editor. Rendering the current version under an assistant message, or letting the model
  write one, is a D9-sized feature (a tool call, a permission, a diff view).
- **Saving always writes a version, even when the text is unchanged.** A save is the user
  saying "this is the version I mean"; suppressing identical content would make the version
  numbers lie about how many edits happened. It does cost a row per save.
- **No delete for an artifact.** The panel creates and appends but does not remove an
  artifact or a version. Append-only is what makes a version switcher trustworthy, and a
  delete wants a confirmation flow and a decision about what a hole in the sequence means.
- **Artifacts are thread-scoped and not exported.** There is no export to a file, no
  markdown download, and no way to move an artifact between threads.
- **No component-level tests for the knowledge or artifacts panels.** The knowledge flow is
  proven end to end (`tests/e2e/knowledge.spec.ts`) and the storage layer in the integration
  suites; the panels' own loading/error/empty states have no renderer harness, as with D6 and
  D7.

## Deferred from D9 — accessibility, states, performance

- **No focus trap inside modal panels.** `useDialogFocus` moves focus into a panel on open,
  returns it to the opener on close, and Escape dismisses it — but `Tab` can still walk out of
  the panel and into the page behind it. A trap (or `inert` on the shell) is the complete
  answer and touches every panel's structure; it is not a one-line change.
- **No network-status push.** "Provider unreachable" is discovered by the next request
  failing. A `navigator.onLine` listener would say it sooner and would also be wrong about
  the provider (an interface being up is not the same as an endpoint answering), so the state
  stays request-driven until there is a reason to change it.
- **Two error states are rendered but not driven end to end.** `settings-load-error` needs a
  locked keychain and the sidebar's `thread-list-error` needs a failure in a local read;
  neither can be produced from outside the app without a broken platform. They are listed in
  `docs/STATES.md` as uncovered rather than counted as covered.
- **The G2 frame clause is still a proxy.** `pnpm perf` reports the worst
  `requestAnimationFrame` gap while scrolling the sidebar; it cannot attribute a long frame to
  script, layout or paint. A real trace (`chrome://tracing` or `PerformanceObserver` long
  tasks) is the next step if the number ever looks bad.
- **Perf runs on one machine.** The corpus is deterministic and the harness is repeatable, but
  the numbers in `PERF.md` describe this laptop. A CI comparison needs a runner with a pinned
  machine and a stored baseline, which is a bigger commitment than one script.
- **axe is a devDependency only.** The audit runs in Playwright against the built app. There is
  no accessibility check in the renderer's own test suite, so a component change is only
  audited when the e2e runs.

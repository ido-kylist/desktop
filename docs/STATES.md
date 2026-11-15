# UI states

Every panel, every state it can be in, and what the user sees. Written because
`AGENTS.md` forbids the failure this prevents: **a read that failed rendering as an empty
list.** "You have no threads" and "we could not read your threads" are different sentences
with different next steps, and only one of them is true at a time.

Two rules the table encodes:

1. **Four read states, always.** *loading* (no answer yet), *empty* (an answer with nothing
   in it), *error* (an answer that is a failure), *offline* (the failure is the provider
   being unreachable, not a refusal). A panel that collapses two of them is wrong even when
   it looks tidy.
2. **A state is a visible sentence, not an implication.** Each cell below names the element
   a user sees and the `data-testid` that proves it, so the matrix can be checked against the
   running app instead of trusted.

Legend for the evidence column: **e2e** = driven in `tests/e2e/` on a real build;
**unit/int** = covered below the UI (`tests/unit`, `tests/integration`); **—** = not
reachable black-box, with the reason given.

## The matrix

### Chat transcript (`src/renderer/src/components/MessageList.tsx`, `App.tsx`)

| State | What the user sees | Evidence |
|---|---|---|
| loading | `Restoring…` under the transcript, as an `<output>` (a polite status region, so it is announced rather than only drawn) | — (a local SQLite read completes in single-digit ms; the state is a frame, not a screen) |
| empty (new chat) | `New thread` heading and one line saying the conversation is stored locally | e2e `boot`, `chat` |
| empty (thread with no turns) | `No messages` heading and "This thread is empty — every turn in it has been deleted." (`thread-empty`) | e2e `states` (soft-deletes every message, relaunches) |
| error (read) | A banner with the contract's code and message (`restore-error`), red | — (only `NOT_FOUND` is producible from outside, and it is deliberately *not* an error: a remembered thread that is gone is forgotten and a new chat starts) |
| error (turn) | `ErrorBanner` with the code, the provider's own message, and Retry (`error-banner`) | e2e `chat` (`BUDGET_EXCEEDED`, `RATE_LIMITED`, `UPSTREAM_TRUNCATED`) |
| offline (provider unreachable) | The same banner with `data-state="offline"`, a warning-coloured frame, and the note "Provider unreachable — … the turn is stored locally" (`error-banner-offline`). Retry stays enabled | e2e `states` (a closed port, so the fetch really fails) |
| live (streaming) | The answer's own body is `aria-live="polite"`; Stop replaces nothing and appears next to Send | e2e `keyboard` (asserts exactly one live region, on `.md`, and none on the list) |

### Composer (`Composer.tsx`)

| State | What the user sees | Evidence |
|---|---|---|
| loading (model catalogue) | `Loading models…` in `composer-model-note`; the select is disabled | e2e `states` (a blackhole server that never answers) |
| empty (no models) | `The endpoint returned no models.` plus the source note | unit `models` |
| error (catalogue) | `CODE: message` in `composer-model-note`, tone `bad` | unit `models` |
| offline | `…Source: fallback — using a built-in list; the endpoint did not answer.` in `composer-model-note` — shown for a *ready* fallback list too, so a built-in model id never looks like a live one | e2e `states` |
| attachments refused | `attach-problem` with a reason (too many, too large, unsupported, unreadable) and a Dismiss button | e2e `chat`/`knowledge` paths; unit `attachment-caps` |

### History sidebar (`Sidebar.tsx`, `ThreadList.tsx`, `ProjectSection.tsx`)

| State | What the user sees | Evidence |
|---|---|---|
| loading | `Loading threads…` | — (local read; a frame) |
| empty (no threads) | `No threads yet.` (`thread-list-empty`) | e2e `boot`/`chat` start here |
| empty (search matched nothing) | `No threads match that search.` — a different sentence from "no threads", because the fix is different | e2e `history` |
| empty (project filter) | `No threads in this project yet.` | e2e `assistants` (projects) |
| error | `CODE message` in `thread-list-error`, red; the list is not drawn | — (a local read cannot fail without a corrupt database) |
| error (row action) | `sidebar-error` with the code; the list is re-read from main, never patched locally | — |
| offline | **Not applicable.** The sidebar reads local SQLite; a provider outage cannot affect it. The nearest state is the read error above | — |

### Settings (`SettingsScreen.tsx`)

| State | What the user sees | Evidence |
|---|---|---|
| loading (settings) | `Loading settings…` (`settings-loading`) | — (local read; a frame) |
| loading (catalogue) | `Loading models…` in `model-note`; the select is disabled | e2e `states` (blackhole) |
| empty | The form is always present once the read answers; "empty" is the catalogue's `empty` state (`model-note`) | unit `models` |
| error (read) | `settings-load-error` banner with the code and a Retry button | — (the only failure is a locked keychain, which needs a platform state the suite cannot arrange) |
| error (write) | `settings-action-error` with the code; the field keeps the draft so nothing typed is lost | unit `settings-form`, int `settings` |
| offline | `settings-offline` (`<output>`): "Provider unreachable — … The model list below is a built-in fallback until it answers", plus `Source: fallback` in `model-note`. The form stays editable | e2e `states` |

### Knowledge (`KnowledgePanel.tsx`)

| State | What the user sees | Evidence |
|---|---|---|
| loading (documents) | `Loading documents…` | — (local read) |
| empty | `No documents yet. Add a text file to search it from a message.` (`kb-list-empty`) | e2e `a11y`, `knowledge` |
| error (read) | `kb-list-error` with the code; the list is not drawn | — (local read) |
| error (add) | `kb-problem` with a reason in words (already indexed / not readable text / too large / unsupported), or `kb-error` with the code | e2e `knowledge` |
| empty (search) | `Nothing matched. An empty corpus and a query with no shared words look the same here.` (`kb-search-empty`) | e2e `knowledge` |
| offline (search / add) | `kb-error` with `data-state="offline"` and "Provider unreachable", because search embeds the query through the configured provider | e2e `states` |

### MCP (`McpPanel.tsx`)

| State | What the user sees | Evidence |
|---|---|---|
| loading (servers) | `Loading servers…` | — (local read + in-memory runtime table) |
| empty | `No servers. Add a command above; nothing runs until you ask for its tools.` (`mcp-list-empty`) | e2e `a11y`, `mcp` |
| error (read) | `mcp-list-error` with the code | — |
| error (action) | `mcp-error` with the code (add / remove / kill / tools / call / approval) | e2e `mcp` |
| **offline equivalent: crashed** | The row's status pill reads `crashed` (red) and the last line the server wrote to stderr is shown (`mcp-server-error`). This is MCP's "the other end is gone" — a local child process, not a network peer | e2e `mcp` (a server that exits) |
| empty (tools) | `This server advertises no tools.` | e2e `mcp` |
| approval pending | `role="alertdialog"` card with the server, tool, arguments and Allow / Deny; nothing runs until Allow | e2e `mcp` |

### Artifacts (`ArtifactsPanel.tsx`)

| State | What the user sees | Evidence |
|---|---|---|
| no thread | `Open a conversation first: an artifact belongs to a thread.` (`artifacts-no-thread`) | e2e `artifacts` |
| loading (list) | `Loading artifacts…` | — (local read) |
| empty | `No artifacts in this thread yet. Start one below; it saves as version 1.` (`artifacts-list-empty`) | e2e `artifacts` |
| error (list) | `artifacts-list-error` with the code | — |
| error (history / save) | `artifacts-history-error` / `artifacts-error` with the code; the draft stays on screen | e2e `artifacts` (save path), unit `artifacts` |
| offline | **Not applicable.** Artifacts are local rows; nothing here calls a provider | — |

### Prompt library and assistants (`PromptLibrary.tsx`, `AssistantPanel.tsx`)

| State | What the user sees | Evidence |
|---|---|---|
| loading / empty / error | The same four `Catalog` states as everywhere else (`Loading prompts…`, `No prompts yet.` / `No prompts match that search.`, `prompt-list-error`) | e2e `assistants` |
| offline | **Not applicable.** Local rows | — |

## Why the "offline" row is not a fifth error code

The IPC contract's closed error set has no `OFFLINE`, and adding one would be a protocol
version bump for a fact the payload already carries. `isProviderUnreachable()`
(`src/renderer/src/lib/connectivity.ts`) derives it structurally:

- an HTTP failure always carries `details.status` (the provider answered and refused);
- a transport failure (refused connection, DNS, TLS, timeout) carries `details.reason` and no
  status.

That is the offline state, and it is the same rule everywhere it appears — the chat banner,
the composer's catalogue note, the knowledge panel's error, and the settings screen's
notice. A new code would have needed a contract bump and a migration of every consumer;
this needed one function and no protocol change.

## What is still missing

- **No network-status push.** "Offline" is discovered by the next request failing, not
  announced when the machine loses its network. A `navigator.onLine` listener would say it
  earlier; it would also claim a provider is reachable whenever the interface is up, which is
  a different question. Recorded in `BACKLOG.md`.
- **No focus trap inside the panels.** Focus enters a dialog on open, returns to the opener on
  close, and Escape closes (`useDialogFocus`); `Tab` can still walk out of the panel and into
  the page behind it. A trap is the complete answer and is in `BACKLOG.md`.
- **`settings-load-error` and the sidebar's read error are not exercised end to end.** Both
  need a failure that only a broken platform keychain or a corrupt database produces; they
  are rendered but not driven by a test. Named here rather than quietly counted as covered.

# Security evidence

The plan's DoD asks for the Electron security items evidenced with file and line. This is that
table, extended at D10 for the surfaces D7 and D8 added: a child-process runtime, a knowledge
store, and a renderer→disk path bridge.

Anything not evidenced here is in **Not evidenced / not claimed** at the bottom rather than
implied. If a claim has no `file:line` beside it, it is not a claim.

Line numbers are as of the D10 hardening branch. D10 changed no production file — only tests,
scripts and docs — so they are also the numbers on `main` at the commit this branch was cut
from. A file that moves re-opens this document; the numbers are the point, not decoration.

## Renderer isolation

| Item | Where | Evidence |
|---|---|---|
| Sandbox enabled process-wide | `src/main/index.ts:76` | `app.enableSandbox()` before `ready` |
| `sandbox: true` | `src/main/index.ts:687` | window `webPreferences` |
| `contextIsolation: true` | `src/main/index.ts:688` | same |
| `nodeIntegration: false` | `src/main/index.ts:689` | same |
| `nodeIntegrationInWorker: false` | `src/main/index.ts:690` | same |
| `webSecurity: true` | `src/main/index.ts:691` | same |
| `allowRunningInsecureContent: false` | `src/main/index.ts:692` | same |
| No remote code | `src/main/index.ts:664-671` | `app://` handler serves only files under the bundle root; `669` returns 403 on a path that escapes it |
| No `unsafe-eval`, no inline script | `src/renderer/index.html:6-9` | `script-src 'self'`; no `unsafe-inline` for scripts |

## The bridge

| Item | Where | Evidence |
|---|---|---|
| One frozen API object, nothing else | `src/preload/index.ts:111` | `contextBridge.exposeInMainWorld("cleon", Object.freeze(api))` |
| Fixed channel allowlist | `src/shared/channels.ts:15-62` | 46 names; `isChannelName()` (`:83`) guards every `invoke` |
| Unknown channel returns an error, not a throw | `src/preload/index.ts:57-62` | `UNKNOWN_CHANNEL` envelope |
| Protocol version | `src/shared/channels.ts:13` | `PROTOCOL_VERSION = 9`; every channel change bumps it |
| Sandboxed preload cannot pull dependencies | build output | `out/preload/index.cjs` contains exactly one `require("electron")` |
| Two push channels, both stripped of the IPC event | `src/preload/index.ts:72-80`, `:100-108` | generation events and deep links; the `IpcRendererEvent` never reaches a renderer callback |
| One non-IPC method, `filePath` | `src/preload/index.ts:92-98` | see the next section |

The preload is CommonJS by design: sandboxed preloads cannot be ESM, and a `require` of
anything outside the allowlist fails silently at runtime — which is exactly the bug the D0 gate
caught (`docs/DECISIONS.md`). Everything the preload imports besides `electron` is the
zod-free half of the contract (`src/shared/channels.ts`), which imports nothing at all.

## `webUtils.getPathForFile` — the one method that is not IPC

Electron 45 removed `File.path`, so a dropped or pasted file no longer carries its location.
`webUtils.getPathForFile(file)` is the supported replacement, exposed as `cleon.filePath(file)`
(`src/preload/index.ts:92-98`).

| Question | Answer | Evidence |
|---|---|---|
| What can it do? | Map a `File` the user dropped or pasted into this window to its absolute path on disk | `src/preload/index.ts:94` |
| Can it read the file? | **No.** It returns a string. The bytes are read in main, by `attachments.add` / `kb.addDocument`, never here | `src/main/attachments/handlers.ts:74`; `src/main/knowledge/sources.ts:102` |
| Can it name a file the user did not choose? | **No.** It takes a `File` object; a `File` constructed in JS is not backed by disk, and the call throws — caught, and `""` is returned | `src/preload/index.ts:93-97` |
| Can it enumerate a directory? | **No.** One `File` in, one path or `""` out | same |
| What does it disclose? | A real absolute path, which contains the user's home directory and account name. That is a genuine, bounded disclosure to renderer JavaScript | same |
| What happens to the path? | It is passed back to main in a channel payload, and main copies the file after its own checks | `src/main/attachments/handlers.ts:74-88` |

The bridge method is not the security gate; the gate is in main. A path is copied only when its
extension is in the allowlist (`src/main/attachments/store.ts:67`, `:75`) and it is under the size
cap (`:25`, 25 MiB) and file count (`:22`, 10). `attachments.preview` additionally refuses
anything that is not an image under 1 MiB (`:200`, `:34`) and re-checks that the row's own path
is inside the attachments root before reading it (`:207`) — a row edited out from under the app
must not become a way to read `/etc/hosts` into a page.

**Residual, stated:** the renderer can ask main to copy *any readable file with an allow-listed
extension*. It does not have to have come from a drop; a path learnt another way works too. That
is the same trust boundary as the app itself — the renderer is app code served from `app://`,
not remote content — but it is a capability worth naming rather than leaving implied.

## Content Security Policy

| Item | Where | Evidence |
|---|---|---|
| CSP declared | `src/renderer/index.html:6-9` | `default-src 'self'`; `script-src 'self'`; no `unsafe-eval`; `connect-src 'self' ws:` |
| Inline styles only | same | `style-src 'self' 'unsafe-inline'` — a deliberate exception for the stylesheet, no inline scripts |
| No raw HTML rendering | `src/renderer/src/lib/markdown.ts` | no `dangerouslySetInnerHTML` anywhere in `src/renderer`; XSS payload unit-tested to render escaped |

## Credentials

| Item | Where | Evidence |
|---|---|---|
| Key encrypted at rest | `src/main/index.ts:134-135` | `safeStorage.encryptString` / `decryptString`; ciphertext in `<userData>/inference-key.enc`, mode `0o600` (`:149`) |
| Fail-closed | `src/main/secrets.ts` | unavailable backend → `UNAUTHORIZED`; never a plaintext fallback |
| Key never crosses IPC | `src/shared/ipc-contract.ts` | every response carries `hasKey` / `masked` only; no response field holds the key |
| Key never in URL or body | `src/main/api/client.ts:267` | `authorization: Bearer …` header only, and only when a key exists |
| Key never in the environment | `src/main/index.ts:129-157` | read from the encrypted file per call; nothing writes it to `process.env` — which is what makes the MCP child inheriting `process.env` not a key leak (below) |
| Redaction proven | `tests/integration/redaction.spec.ts` | canary absent from disk bytes, masked value, URL and body; mutation-tested — a plaintext backend fails five assertions |
| Redaction extended to D7/D8 | `tests/integration/redaction.spec.ts` | one full flow (ingest → search → send → approve → save) then every table and every file under the user-data dir is scanned for the canary; mutation-tested three ways — see `gates/G10.md` |
| Cannot be committed | GitHub | secret scanning + push protection enabled on the repo |

## The MCP runtime (D7): subprocess isolation

An MCP server is a local program the user adds. Running arbitrary local programs is the
feature, not a defect — so the claims below are about containment and consent, not about
preventing execution.

| Item | Where | Evidence |
|---|---|---|
| No shell | `src/main/mcp/manager.ts:327-333` | `spawn(row.command, row.args, { shell: false })`; `args` is an array, so a `;` in an argument is a character, not a separator |
| Piped stdio | same | `stdio: ["pipe","pipe","pipe"]`; JSON-RPC one object per line, both directions |
| One child per server, spawned lazily | `src/main/mcp/manager.ts:297-322` | adding a server is a row; a process starts on `listTools` or an allowed call, and a server nobody uses never runs |
| No implicit restart | `src/main/mcp/manager.ts:303-312` | a `crashed` runtime throws with the last stderr line; restarting is an explicit `killServer` then `listTools` |
| No tool runs without an approval row | `src/main/mcp/manager.ts:154-172` | `requestToolCall` only writes a `pending` row; execution is `resolveApproval`, whose conditional `UPDATE` matches `status = 'pending'` |
| One execution per approval | `src/main/mcp/manager.ts:189-210`, `:281-288` | re-resolving is `CONFLICT`; the in-flight set blocks a double click; the status write is conditional |
| SIGTERM, then SIGKILL | `src/main/mcp/manager.ts:446-480` | `terminate`: `SIGTERM`, `SIGKILL` after `killGraceMs` (2 s), and a bail timer at twice that so a kill is bounded |
| Nothing left running on quit | `src/main/index.ts:753-755` → `manager.ts:218-227` | `before-quit` calls `dispose()`, which signals and schedules the hard kill without awaiting |
| Arguments are never logged | `src/main/mcp/manager.ts:166-170`, `:247-254`, `:269-274` | every log line carries `tool` and `argBytes`; a byte count distinguishes "empty" from "something", and nothing more |
| A malformed line is logged by size, not content | `src/main/mcp/manager.ts:340-347` | `bytes` and the parse error; never the line, which could be a fragment carrying arguments |
| Stderr is capped | `src/main/mcp/manager.ts:45`, `:376-378` | last 2 000 characters kept for the panel's crash reason |
| A server cannot throw the app | `src/main/mcp/manager.ts:363-400` | stream `error` handlers, plus `error`/`close` on the child, all become a status and a string |
| The child inherits the environment | `src/main/mcp/manager.ts:332` | `env: { ...process.env, ...row.env }` — stated so it is not a surprise: a server sees every variable the app was launched with. The API key is **not** among them (`index.ts:129-157`) |

**What this does not do.** It does not sandbox the child: an MCP server runs with the user's
privileges, can read any file the user can read, and can open a socket. Piping stdio and
avoiding a shell bound *how the app talks to it*, not what it may do once running. That is why
the approval gate exists, and why the approval names the tool and shows the arguments.

## Knowledge and artifacts (D8)

### Documents leave the machine

This is a privacy fact, not a bug, and it belongs in plain words:

- **Ingesting a document sends its text to your configured provider.** The file is chunked
  locally, then the chunk text is POSTed to `{baseUrl}/v1/embeddings` as `{ model, input }`
  (`src/main/knowledge/service.ts:105` → `src/main/api/embeddings.ts:77-87`). The file copy stays
  local; the text does not.
- **Every search sends your query** the same way (`src/main/knowledge/service.ts:189`), and so
  does every knowledge-backed turn, because retrieval embeds the question first.
- **Every chat turn sends the conversation so far** to the chat endpoint. With knowledge on, the
  retrieved chunks go with it, inside the system message (`buildKnowledgePrompt`, `:291-305`).
- **Transport is whatever the base URL says.** The app does not force TLS and cannot: a
  self-hosted endpoint on `http://localhost` is a supported configuration. `resolveBaseUrl`
  (`src/main/api/client.ts:47-71`) normalises a trailing slash and nothing else. If the URL is
  `https://`, the request is TLS; if it is `http://`, it is not.
- **Nothing is sent anywhere else.** There is no telemetry endpoint, no crash uploader, and no
  auto-update feed configured (`package.json` lists `electron-updater`; no feed is set).

### The knowledge store is plaintext at rest

| What | Where | At rest |
|---|---|---|
| A copy of every ingested file | `<userData>/knowledge/<documentId>.<ext>` (`src/main/knowledge/sources.ts:102`, `:139`) | **plaintext**, unencrypted |
| Chunk text | `chunks.text` (`src/main/db/migrations.ts:297`) | **plaintext** in SQLite |
| Vectors | `chunks.embedding` BLOB of float32 (`:298-299`) | opaque bytes, but not encryption — they decode back to a vector of the text |
| Titles and source paths | `documents.title`, `documents.source_path` (`:282-290`) | plaintext |
| Artifact text | `artifact_versions.content` (`:319`) | **plaintext** in SQLite |
| Messages and threads | `messages.text`, `threads.title` | plaintext |

The only thing the app encrypts is the API key. Everything the user types or imports is stored
in cleartext in `<userData>`, and the at-rest protection is the operating system's: the user
account's file permissions, plus FileVault/BitLocker if the user has enabled it. A person with
read access to the user's home directory can read the corpus. That is a deliberate trade — a
local-first app that encrypts its own database needs a key the user must supply or a hardware
secret to bind to, and neither exists in this slice. It is recorded in `BACKLOG.md` rather than
papered over.

Citations are metadata only: id, document id, title, ordinal (`messages.citations_json`,
`migrations.ts:325`). The chunk text is read back on demand through `kb.readChunk`, so a message
row is not a second copy of the corpus.

## Network and navigation

| Item | Where | Evidence |
|---|---|---|
| No new windows | `src/main/index.ts:701-704` | `setWindowOpenHandler` denies; `https://` links go to the system browser |
| No in-app navigation | `src/main/index.ts:706-711` | `will-navigate` blocked unless `app://` |
| No permission prompts | `src/main/index.ts:725-727` | `setPermissionRequestHandler` denies every permission |
| Remote content never loaded | `src/main/index.ts:69-74` | the only privileged scheme is `app://`, registered before `ready` |
| One outbound host per feature | `src/main/api/client.ts`, `src/main/api/embeddings.ts` | chat and embeddings both go to the configured `baseUrl`; there is no second endpoint |

## Supply chain

| Item | Where | Evidence |
|---|---|---|
| No dynamic dependencies in the bridge | build output | one `require` in the preload |
| Every merge gated | GitHub | enforced branch protection, admins included; a rejected direct push is recorded in `gates/G0.md` |
| Dependencies pinned exactly | `package.json` | exact versions, no ranges for runtime deps |

## Not evidenced / not claimed

- **No notarization or code signing.** There is no Developer ID certificate; the DMG ships unsigned
  with a documented `xattr` step. No signature was faked.
- **No third-party penetration test**, no fuzzing beyond the SSE parser's chunk-split tests.
- **No CSP report-uri** — violations are not collected anywhere.
- **No auto-update.** `electron-updater` is a dependency but no feed is configured, so there is no
  signed-update path to verify or attack.
- **MCP children are not sandboxed.** No seatbelt/AppContainer profile, no cgroup, no network
  namespace. A server runs with the user's full privileges. The containment is the approval gate
  and the pipe — not an OS sandbox. Claiming otherwise would be false.
- **MCP arguments are stored, not redacted.** `mcp_approvals.args_json` holds what the call was
  requested with, because the approval dialog has to show it. If a user pastes a secret into a
  tool's arguments, it is written to the database in cleartext. The app does not guess which
  argument is a credential.
- **The knowledge corpus is unencrypted.** See "plaintext at rest" above. The claim is not "it is
  safe"; the claim is "this is exactly where the bytes are".
- **Embedding and chat traffic is only as private as the configured endpoint.** The app cannot
  verify a provider's retention. A local endpoint keeps the text on the machine; a hosted one
  does not, and the difference is a setting, not a guarantee.
- **No memory-hardening flags.** The renderer and main run with Electron's defaults; there is no
  `--js-flags`, no seccomp filter, no ASLR tuning of our own.
- **No rate limit or quota on local channels.** A compromised renderer can call a channel in a
  loop; the database is the only brake.
- **The `filePath` bridge discloses absolute paths** for files the user chose (see above), and main
  will copy any readable path with an allow-listed extension that the renderer names.
- **Secrets are not memory-zeroed.** The decrypted key is a JavaScript string; it lives until the
  GC takes it, and a core dump or a debugger could read it.

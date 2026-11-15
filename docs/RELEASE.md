# Cleon Desktop 0.2.0

A local-first AI chat client for macOS. Everything you type lives in SQLite on your own
disk; conversations branch instead of forming a flat list; cost is shown per message; MCP
tools run only with your explicit per-call approval; and the renderer is sandboxed with no
path to your API key.

**This is an unsigned build.** There is no Developer ID certificate, so macOS will quarantine
it. That is expected:

```bash
xattr -dr com.apple.quarantine /Applications/Cleon.app
```

## New since 0.1.0

| | |
|---|---|
| **Provider settings** | paste a key, set a base URL, pick a model — the packaged app talks to any OpenAI-compatible endpoint without environment variables. The key goes to the OS keychain via `safeStorage`; only `••••last4` ever crosses to the UI |
| **Attachments** | drag, paste, or pick up to 10 files (25 MiB each) — images and PDF/TXT/MD — with distinct refusals for `too_large`, `too_many`, `unsupported_type` |
| **Native shell** | `⌥Space` launcher over any app, menu-bar tray, `cleon://thread/<id>` deep links, notifications |
| **Projects, assistants, prompts** | organise threads into projects, send under an assistant (own model, temperature, system prompt), and keep a searchable prompt library with `{{date}}`/`{{time}}`/`{{thread_title}}`/`{{project_name}}` expansion |
| **MCP** | register stdio MCP servers, list their tools, and approve every call individually. Default-deny, a crash is contained to the server, and a kill switch exists |
| **Knowledge** | ingest documents, chunk and embed them, and get answers with citation chips that expand to the exact source chunk |
| **Versioned artifacts** | save assistant output as an artifact; every edit is a new immutable version with a switcher |

## Measured, not claimed

- **Performance** (`PERF.md`, 500 threads × 10 messages): `threads.list` p95 **0.65 ms**, FTS search p95 **6.91 ms**, `chat.thread` p95 **0.17 ms**. G2's 100 ms target is met by two orders of magnitude.
- **Soak** (`docs/SOAK.md`): 30 minutes, **10,825 turns**, **43,300 streamed deltas**, zero crashes, zero leaked bus listeners, RSS plateauing at ~200 MB rather than climbing.
- **Accessibility**: axe-core clean on chat, history, settings, knowledge and MCP — zero serious, critical, moderate or minor violations — plus a keyboard-only conversation test with no mouse events.
- **Tests**: 475 unit/integration, 26 end-to-end against the real app, 2 against an installed bundle.

## What is still not in this build

Recorded in `BACKLOG.md`, not silently missing:

- **Fork / user-message branching.** Regenerate creates sibling variants; editing a user message into a branch and forking a subtree do not exist.
- **PDF text extraction.** PDFs are stored and refused for ingestion rather than decoded into mojibake.
- **Cross-thread knowledge search.** Retrieval is per-query over the corpus you have ingested; there is no corpus-level index view.
- **ANN index.** Search is a linear scan over stored vectors — O(n), fine locally, stated plainly.
- **Local-time prompt variables.** `{{date}}`/`{{time}}` are UTC so a prompt expands identically everywhere.
- **Windows/Linux tray icon.** Text-only tray; needs a 16×16 asset there.
- **Notarization.** Unsigned, as above.

## Privacy facts worth stating

- **Knowledge ingestion sends your document text to your configured provider** to compute embeddings. That is how retrieval works; it is not local.
- The API key never reaches the renderer, and the app cannot read it back — only set, test, or clear.
- MCP servers are child processes with pipe stdio and no shell. That is isolation from the app, **not** an OS sandbox: a malicious server still runs as you.

## Verification behind this build

Every PR merged through enforced branch protection with admins included; CI green required.
The DMG below was mounted, installed to a clean path, and exercised by the packaged test
suite for boot, protocol handshake, SQLite v7 with FTS5, and a completed chat turn.

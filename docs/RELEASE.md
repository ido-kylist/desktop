# Cleon Desktop 0.1.0

A local-first AI chat client for macOS. Everything you type lives in SQLite on your
own disk; conversations branch instead of being a flat list; cost is shown per
message; and the renderer is sandboxed with no path to your API key.

**This is an unsigned build.** There is no Developer ID certificate, so macOS will
quarantine it. That is expected:

```bash
xattr -dr com.apple.quarantine /Applications/Cleon.app
```

## What works

| | |
|---|---|
| Streaming chat | tokens stream from any OpenAI-compatible endpoint; Stop aborts mid-stream |
| Local persistence | SQLite (WAL) in your user data dir; quit and relaunch restores the conversation |
| Branching | regenerate produces a sibling variant; switch with `n / total`; the next turn continues from the variant on screen |
| History | sidebar with server-side FTS5 search, rename, pin, archive, soft delete |
| Cost meters | per-message tokens and cost, plus a thread total, read from the persisted generation row |
| Honest errors | 402 → budget banner with no retry; 429 → countdown from `Retry-After`; truncated stream → explicit failure, never a silent half-answer |
| Secrets | API key encrypted with Electron `safeStorage`, never sent to the renderer, fail-closed if the OS keychain is unavailable |

## What is not in this build

Cut deliberately, recorded in `BACKLOG.md`, not silently missing:

- **Attachments, native shell (`⌥Space` launcher, deep links), assistants/prompts/projects, MCP, knowledge/RAG** — plan phases D4–D8, cut at the plan's own cut line.
- **Fork and user-message branching.** Regenerate creates siblings; editing a user message into a branch does not exist yet.
- **No model picker** — the composer lists mock endpoints. A real catalog is D6.
- **No title generation** — new threads are called "New thread" until renamed.
- **Markdown is a subset** — code, emphasis, links, lists. No tables, images, headings.
- **Reasoning and tool calls are not persisted**, so a restored turn is text only.
- **No performance numbers.** G2's targets (500 threads, p95 < 100 ms, 60 fps) are unmeasured.

## Verification behind this build

- 187 unit/integration tests, 8 e2e against the real app, 2 packaged e2e against the
  installed bundle from this DMG.
- Typecheck covers `src` **and** `tests`; lint clean; every merge gated by CI behind
  enforced branch protection (admins included).
- The packaged app is tested for the thing that matters: boot, protocol handshake,
  SQLite v2 with FTS5, and **a completed chat turn**.

## Known gaps

- The chat is verified against the bundled mock server. A real provider needs your key;
  no code change is required, but this build has never talked to a paid endpoint.
- Unsigned, unnotarized. Documented above rather than papered over.

# Cleon Desktop 0.2.1

A local-first AI chat client for macOS. Everything you type lives in SQLite on your own
disk; conversations branch instead of forming a flat list; cost is shown per message; MCP
tools run only with your explicit per-call approval; and the renderer is sandboxed with no
path to your API key.

**This is an unsigned build.** There is no Developer ID certificate, so macOS will quarantine
it. That is expected:

```bash
xattr -dr com.apple.quarantine /Applications/Cleon.app
```

Or: double-click once, then **System Settings → Privacy & Security → Open Anyway**.

## What changed in 0.2.1

**The model is now a text field, not a dropdown.** A provider's catalog does not
necessarily list the ids its own endpoint accepts, so a dropdown could not express a working
model at all.

- **Settings → Default model** and the **composer model** are free-text inputs, styled and
  behaving like Base URL — with a Save button offered only when the value actually changed.
- The fetched catalog is still there as a **suggestion list** (native datalist): start typing
  and pick from what the endpoint advertises. You are never constrained to it.
- A value outside the catalog says so plainly: *"Not in this endpoint's catalog — sending
  anyway."*
- **One-click prefix fix.** Some endpoints reject bare model ids and demand a deployment
  prefix. On `INVALID_DEPLOYMENT_TARGET` the error banner offers a **Use
  `/deployments/serverless/…`** button that rewrites the field — visible and reversible, never
  a silent retry.
- An empty model is refused before anything is written to the database.

### If you use Sciforium

Its `/v1/models` advertises `deepseek-ai/DeepSeek-V4.1-Flash-1017`, but completions reject that
form:

```
/deployments/serverless/deepseek-ai/DeepSeek-V4.1-Flash-1017    ← works
deepseek-ai/DeepSeek-V4.1-Flash-1017                             ← 400 INVALID_DEPLOYMENT_TARGET
```

Type the prefixed form, or let the error banner's button fill it in.

## Everything from 0.2.0 is here

Provider settings (key in the OS keychain, base URL, catalog) · attachments with caps and
distinct refusals · native shell (`⌥Space` launcher, tray, `cleon://` deep links,
notifications) · projects, assistants and a prompt library with variable expansion · MCP over
stdio with per-call approval, containment and a kill switch · knowledge ingestion with
citation chips · versioned artifacts.

## Measured, not claimed

- `threads.list` p95 **0.65 ms**, FTS search p95 **6.91 ms**, `chat.thread` p95 **0.17 ms**
  against 500 threads × 10 messages (`PERF.md`).
- Soak: 30 minutes, **10,825 turns**, zero crashes, zero leaked listeners, RSS plateau ~200 MB
  (`docs/SOAK.md`).
- axe clean on five screens; keyboard-only conversation test green.
- **489 unit/integration, 26 end-to-end, 2 against an installed bundle.**

## Still not in this build

Recorded in `BACKLOG.md`, not silently missing: fork / user-message branching · PDF **text**
extraction · cross-thread knowledge search · ANN index (search is an O(n) scan) · local-time
prompt variables (`{{date}}`/`{{time}}` are UTC) · Windows/Linux tray icon · signing and
notarization.

## Privacy facts worth stating

- **Knowledge ingestion sends your document text to your configured provider** to compute
  embeddings. That is how retrieval works; it is not local.
- The API key never reaches the renderer, and the app cannot read it back — only set, test, or
  clear.
- MCP servers are child processes with pipe stdio and no shell. That is isolation from the app,
  **not** an OS sandbox: a malicious server still runs as you.

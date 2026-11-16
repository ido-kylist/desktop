# Cleon Desktop 0.2.2

A local-first AI chat client for macOS. Everything you type lives in SQLite on your own
disk; conversations branch instead of forming a flat list; cost is shown per message; MCP
tools run only with your explicit per-call approval; and the renderer is sandboxed with no
path to your API key.

**This is an unsigned build.** No Developer ID certificate, so macOS quarantines it:

```bash
xattr -dr com.apple.quarantine /Applications/Cleon.app
```

Or: double-click once, then **System Settings → Privacy & Security → Open Anyway**.

## What changed in 0.2.2

**A model id you type is now used exactly as typed.** It was being silently replaced.

Typing `/deployments/d62861ef/deepseek-ai/DeepSeek-V4.1-Flash-1017` and pressing Save showed a
different model. The cause was a leftover from when the model was a dropdown: a helper kept
the stored value *only if the endpoint's catalog listed it*, and otherwise substituted the
first catalog entry. That value was used both for the field and for the request, so the wrong
model went on the wire — and on Sciforium the substitute is a bare id that returns
`400 INVALID_DEPLOYMENT_TARGET`, about a model you never chose.

Now:

- **The configured value is used verbatim.** The endpoint's `/v1/models` list is a
  suggestion; it never overrides what you typed.
- **The catalog's first entry is a default only for a profile where nothing is configured.**
  It is never used as a correction.
- **No more `mock/text` fallback.** A packaged app pointed at a real provider will not send a
  mock id that nobody chose.
- **Empty means empty.** Clearing the field keeps it cleared, disables Send, and says *"Set a
  model in Settings before sending"* instead of quietly refilling from the catalog.
- The composer now shows *"Not in this endpoint's catalog — sending anyway"* where you
  actually send, matching Settings.

### Fixed alongside

**The app's own test suite no longer competes with a running copy.** If you had the
installed app open, one spec failed as a blank window because it shared Electron's
single-instance lock. It now uses its own profile like every other spec. That was a test
defect, not a product one — the single-instance behaviour is correct.

## Everything from 0.2.0 / 0.2.1 is here

Provider settings (key in the OS keychain, base URL, catalog) · attachments with caps and
distinct refusals · native shell (`⌥Space` launcher, tray, `cleon://` deep links,
notifications) · projects, assistants and a prompt library with variable expansion · MCP over
stdio with per-call approval, containment and a kill switch · knowledge ingestion with
citation chips · versioned artifacts · free-text model fields.

## Measured, not claimed

- `threads.list` p95 **0.65 ms**, FTS search p95 **6.91 ms**, `chat.thread` p95 **0.17 ms**
  against 500 threads × 10 messages (`PERF.md`).
- Soak: 30 minutes, **10,825 turns**, zero crashes, zero leaked listeners, RSS plateau ~200 MB
  (`docs/SOAK.md`).
- axe clean on five screens; keyboard-only conversation test green.
- **492 unit/integration, 28 end-to-end, 2 against an installed bundle.**

## Still not in this build

`BACKLOG.md`, not silently missing: fork / user-message branching · PDF **text** extraction ·
cross-thread knowledge search · ANN index (search is an O(n) scan) · local-time prompt
variables (`{{date}}`/`{{time}}` are UTC) · Windows/Linux tray icon · signing and notarization.

## Privacy facts worth stating

- **Knowledge ingestion sends your document text to your configured provider** to compute
  embeddings. That is how retrieval works; it is not local.
- The API key never reaches the renderer, and the app cannot read it back — only set, test, or
  clear.
- MCP servers are child processes with pipe stdio and no shell. That is isolation from the app,
  **not** an OS sandbox: a malicious server still runs as you.

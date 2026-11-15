# Demo script — five minutes

Run it twice before showing anyone. Every step below has been executed; if it fails on
the day, the build is wrong, not the script.

## Setup (before the audience)

```bash
# 1. mock inference server
cd ~/Developer/desktop && PORT=4790 node mock/server.mjs &   # keep it running

# 2. the app, pointed at the mock, with a throwaway profile
CLEON_API_BASE=http://127.0.0.1:4790 CLEON_USER_DATA=/tmp/cleon-demo open /Applications/Cleon.app
```

Point 1 is the only preparation. Do not demo against a paid endpoint unless you have
already run this script against it once.

## The five minutes

1. **Streaming (30 s).** Type "hello" and press Enter. Tokens arrive one at a time.
   Say the thing that matters: *the user message is written to SQLite before the request
   leaves the machine* — kill the network mid-stream and nothing is lost.

2. **Stop (15 s).** Send a second message and hit Stop mid-stream. It stops cleanly, no
   error banner. Stopping is not failing.

3. **Honest errors (45 s).** Set the model to `mock/402` and send.
   → budget banner, **no retry button**, because retrying a 402 is theatre.
   Set `mock/429` and send → banner with a live countdown from `Retry-After`.
   Set `mock/truncated` → an explicit failure, not a half-answer presented as complete.

4. **Branching (90 s).** Switch back to `mock/text`, send a question, then hit
   **Regenerate**. A `2 / 2` switcher appears. Flip between them — two different
   answers to the same question. Point out that the next turn continues from whichever
   variant is on screen; that is the whole difference from a flat chat log.

5. **Cost (30 s).** Point at the per-message meter and the thread total. These come from
   the persisted generation row, not from the UI guessing.

6. **Persistence (45 s).** Quit the app with ⌘Q. Reopen it. The conversation, including the
   selected variant, is exactly where it was.

7. **History and search (45 s).** Send a message in a new chat mentioning a distinctive
   word. Use the sidebar search. It finds the thread by **message content**, matched in
   SQLite's FTS5 index on the main process — the renderer never filters a list it holds.

8. **The trust claim (30 s).** Open Activity Monitor, or just say it: the renderer runs
   sandboxed with context isolation and no Node integration, and the API key never leaves
   the main process. The bridge exposes a fixed channel list, nothing else.

## If something breaks

- Blank window → the app could not reach the renderer bundle; check `Console.app` for `app://`.
- "Monitor server unreachable"-style banner → the mock died; restart step 1.
- Everything stuck at "New thread" → send failed before persistence; check the terminal
  running the mock.

## What not to claim

- Do not call the performance numbers. They were never measured.
- Do not claim attachments, launcher, MCP or RAG. They are cut, and `BACKLOG.md` says so.
- Do not say "signed". It is unsigned, and the `xattr` line is in the README.

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


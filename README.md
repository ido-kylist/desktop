# Cleon Desktop

A local-first AI inference app: everything you write lives in SQLite on your disk,
branching is native, cost is shown per message, and every tool call is visible
before it runs.

Status: **D0 — foundation**. The shell boots, the IPC contract is frozen, the
database schema applies, and the mock inference server streams. The chat surface
arrives in D1.

## Requirements

- macOS (arm64), Node 24, pnpm 10

## Quickstart

```bash
pnpm install
pnpm build          # main + preload + renderer
pnpm start          # launch the built app
```

Development, with HMR in the renderer:

```bash
pnpm dev
```

## Checks

```bash
pnpm typecheck      # tsc, both projects, strict
pnpm lint           # biome
pnpm test           # vitest: unit + integration (mock SSE contract)
npx playwright test # launches the real app, asserts the handshake and SQLite
pnpm build:mac      # unsigned DMG in release/
```

## Mock inference server

No API key is needed to work on the client:

```bash
pnpm mock                                  # 127.0.0.1:4790
curl -s localhost:4790/v1/models
```

The model name selects the scenario: `mock/text`, `mock/reasoning`,
`mock/tool`, `mock/truncated`, `mock/402`, `mock/429`. See `mock/server.mjs`.

## Layout

```
src/main/        privileged: windows, ipc, db, secrets (D1+)
src/preload/     contextBridge, channel allowlist — CommonJS, sandboxed
src/renderer/    React app
src/shared/      channels.ts (zod-free) + ipc-contract.ts (schemas)
mock/            inference server + SSE fixtures
tests/           integration (vitest) and e2e (playwright)
```

## Security posture

The renderer runs sandboxed with context isolation, no Node integration, and a
custom `app://` scheme with a path-traversal guard. It can only reach the channels
declared in `src/shared/channels.ts`. The API key never enters the renderer.

## Installing an unsigned build

There is no Developer ID certificate yet, so the DMG is unsigned. macOS will
quarantine it. That is expected, not a bug:

```bash
xattr -dr com.apple.quarantine /Applications/Cleon.app
```

## Decisions

Every non-obvious choice is recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md).

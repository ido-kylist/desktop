# Decisions

Dated, with the reasoning that made them. A decision without a reason is a rumour.

## D0 — stack pins

The plan pins exact versions (Rev 4 §2.5). All were verified to exist on npm
before install, rather than trusted:

```
electron 45.3.2 · electron-vite 6.0.0 · electron-builder 26.18.0
better-sqlite3 13.1.1 · drizzle-orm 0.45.4 · zod 4.6.7 · zustand 5.1.0
@tanstack/react-query 5.107.1 · react 19.1.10 · typescript 5.9.3
biome (@biomejs/biome) 2.3.11 · vitest 5.1.0 · @playwright/test 1.65.1
```

`biome` is published as `@biomejs/biome`; the plan's shorthand would not have installed.

## D0 — the preload cannot import zod

**Problem.** `electron-vite` externalises dependencies for the preload target even
without `externalizeDepsPlugin`, and a sandboxed preload's `require` is limited to
`electron` plus a few builtins. Importing the contract (which imports zod) therefore
produced `require("zod")` in the bundle and the bridge silently never appeared —
the window rendered, `window.cleon` was `undefined`, and nothing threw anywhere
visible.

**Decision.** Split the contract in two:

- `src/shared/channels.ts` — no imports at all: `PROTOCOL_VERSION`, `CHANNEL_NAMES`, `isChannelName`.
- `src/shared/ipc-contract.ts` — imports zod, holds the schemas, and re-exports the channels module.

`ipc-contract.ts` declares `contracts` with `satisfies Record<ChannelName, Contract>`, so a
name without a schema (or a schema without a name) is a compile error. The preload
imports only `channels.ts`, and the bundle is 578 bytes with exactly one require.

**Consequence.** The preload stays sandboxable. Any future preload need must be
satisfiable without zod, or it belongs in main behind a channel.

## D0 — migrations are inline and checksummed at runtime

`drizzle-kit` cannot express FTS5 virtual tables or their triggers, so the migration
that matters most cannot be generated. Rather than commit a generated migration and
a hand-written one that disagree, the SQL lives in `src/main/db/migrations.ts` and is
checksummed (SHA-256, first 32 hex chars) into `schema_migrations` on apply. A mutated
migration is a hard startup failure.

The Drizzle schema in `src/main/db/schema.ts` remains the source of truth for queries.

## D0 — better-sqlite3 needs no Electron rebuild

`better-sqlite3` 13.1.1 ships N-API bindings, so the module built against Node 24 loads
unchanged inside Electron 45. Verified, not assumed: the e2e test asserts the app reads
`schemaVersion: 1` and `fts5: true` from a real database inside the packaged runtime.

## D0 — unsigned DMG

There is no Developer ID certificate on this machine. The DMG is built with
`identity: null` and the README documents the `xattr -dr com.apple.quarantine` step.
Faking a signature was never an option.

## D0 — branch protection is not available on this repo's plan

Both `PUT /branches/main/protection` and `POST /rulesets` return **403: "Upgrade to
GitHub Pro or make this repository public"**. A private repository on the free plan
cannot require status checks before merge.

**Consequence.** G0's "branch protection requiring CI" clause is **not met**, and this is
recorded rather than papered over. CI still runs on every push and PR, and it is the
gate in practice — but it is not *enforced* by the platform.

**Options, for the owner to choose:** make the repo public, upgrade to Pro, or accept
unenforced CI until D11.


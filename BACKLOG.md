# Backlog

Work consciously deferred. Nothing here is a surprise in a demo, because it is written down.

## Deferred from D0

- **Branch protection / rulesets.** Both APIs return 403 on a private free-plan repo. CI runs
  and is green-or-red on every push, but the platform does not *enforce* it. Owner decision:
  make public, upgrade to Pro, or accept until D11. See `docs/DECISIONS.md`.

- **App icon.** electron-builder used the default Electron icon. A real icon set
  (`build/icon.icns`) belongs with D9 polish.
- **Code signing / notarization.** No Developer ID certificate on this machine. The DMG is
  unsigned by design; the README documents the quarantine step. Revisit in D11 when
  credentials may exist.
- **Drizzle-generated migrations.** FTS5 cannot be expressed by drizzle-kit, so migrations are
  hand-written and checksummed at runtime. Revisit only if drizzle-kit gains virtual-table support.
- **Renderer test harness.** No component tests yet; D1 introduces the chat surface and the
  first component-level tests with it.

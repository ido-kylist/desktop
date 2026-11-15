# Security evidence

The plan's DoD asks for the Electron security items evidenced with file and line. This is that
table. Anything not evidenced here is marked as such rather than implied.

Verified at `v0.1.0`. Line numbers refer to that tag.

## Renderer isolation

| Item | Where | Evidence |
|---|---|---|
| Sandbox enabled process-wide | `src/main/index.ts:57` | `app.enableSandbox()` before `ready` |
| `sandbox: true` | `src/main/index.ts:359` | window `webPreferences` |
| `contextIsolation: true` | `src/main/index.ts:360` | same |
| `nodeIntegration: false` | `src/main/index.ts:361` | same |
| `webSecurity: true` | `src/main/index.ts:363` | same |
| `allowRunningInsecureContent: false` | `src/main/index.ts:364` | same |
| No remote code | `src/main/index.ts:341-342` | `app://` handler serves only files under the bundle root, 403 on traversal |

## The bridge

| Item | Where | Evidence |
|---|---|---|
| One frozen API object, nothing else | `src/preload/index.ts:53` | `contextBridge.exposeInMainWorld("cleon", Object.freeze(api))` |
| Fixed channel allowlist | `src/shared/channels.ts` | 14 names; `isChannelName()` guards every call |
| Unknown channel returns an error, not a throw | `src/preload/index.ts` | `UNKNOWN_CHANNEL` envelope |
| Sandboxed preload cannot pull dependencies | build output | `out/preload/index.cjs` contains exactly one `require("electron")`, 578 B |

The preload is CommonJS by design: sandboxed preloads cannot be ESM, and a `require` of
anything outside the allowlist fails silently at runtime — which is exactly the bug the D0 gate
caught (`docs/DECISIONS.md`).

## Content Security Policy

| Item | Where | Evidence |
|---|---|---|
| CSP declared | `src/renderer/index.html:7` | `default-src 'self'`; `script-src 'self'`; no `unsafe-eval` |
| Inline styles only | same | `style-src 'self' 'unsafe-inline'` — a deliberate exception for the stylesheet, no inline scripts |
| No raw HTML rendering | `src/renderer/src/lib/markdown.ts` | no `dangerouslySetInnerHTML` anywhere in `src/renderer`; XSS payload unit-tested to render escaped |

## Credentials

| Item | Where | Evidence |
|---|---|---|
| Key encrypted at rest | `src/main/index.ts:112-114` | `safeStorage.encryptString` / `decryptString` |
| Fail-closed | `src/main/secrets.ts` | unavailable backend → `UNAUTHORIZED`; never a plaintext fallback |
| Key never crosses IPC | `src/shared/ipc-contract.ts` | every response carries `hasKey` / `masked` only; no response field holds the key |
| Key never in URL or body | `src/main/api/client.ts:237` | `authorization: Bearer …` header only |
| Redaction proven | `tests/integration/redaction.spec.ts` | canary key absent from disk bytes, masked value, URL and body; mutation-tested — a plaintext backend fails all four |
| Cannot be committed | GitHub | secret scanning + push protection enabled on the repo |

## Network and navigation

| Item | Where | Evidence |
|---|---|---|
| No new windows | `src/main/index.ts:373` | `setWindowOpenHandler` denies; https links go to the system browser |
| No in-app navigation | `src/main/index.ts:378` | `will-navigate` blocked unless `app://` |
| No permission prompts | `src/main/index.ts:397` | `setPermissionRequestHandler` denies every permission |
| Remote content never loaded | `src/main/index.ts:50` | privileged scheme is `app://`, registered before `ready` |

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

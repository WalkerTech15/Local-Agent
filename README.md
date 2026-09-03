# Local Agent

A local-first, permission-controlled desktop assistant for Windows. The
assistant is named **JARVIS** by default; the product is **Local Agent**.

> **Status: Phase 1 complete. Phase 2, Milestone 1 (chat foundation) in progress.**
> Phase 1 delivered the hardened desktop shell, non-secret settings storage,
> an audit-log foundation, the permission-policy runtime, persisted
> emergency-stop state, first-run onboarding, an encrypted secret store, and
> CI. Phase 2 Milestone 1 adds a **mock-only chat foundation**: a validated
> chat message and conversation model, a provider-independent
> `ChatProvider` interface, a deterministic mock provider, and a chat surface
> in the renderer with empty, loading, error and retry states. **No real
> model provider is called. No network request is made anywhere in this
> milestone** — the mock provider lives entirely inside `src/shared`, where
> the same lint boundary that blocks Electron and Node access also blocks
> `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource` as globals. Chat
> requires **no new IPC channel**: it never calls `window.localAgent`, so
> nothing a chat message contains can reach a privileged API, a file, or the
> permission engine. See
> [docs/phase-2-chat-architecture.md](docs/phase-2-chat-architecture.md) for
> the full design and for what remains explicitly deferred (real providers,
> tool/action execution from model output, memory, and everything else Phase
> 2 has not reached yet).

All rights reserved. No licence has been granted for this project.

---

## The governing rule

> **Models propose actions. Only the permission-controlled executor performs them.**

Every privileged operation is described as an inert proposal, evaluated
against a default-deny permission policy, confirmed by the user when it is
destructive or sensitive, performed by a single executor module, and recorded
in an append-only audit log. A model's reasoning never carries authority of
its own.

## Phase 1 scope

Phase 1 delivers a hardened desktop shell and a first-run onboarding flow. It
performs no AI inference and takes no autonomous action.

- Project scaffold and Windows desktop application shell
- First-run onboarding: assistant name, user name, interface language
- Model-provider settings foundation (settings only, no model calls)
- Secure local settings storage, with secrets kept outside settings entirely
- Permission-policy foundation, audit-log foundation, emergency-stop foundation
- Documentation and automated tests

See [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md) for the full specification and
[docs/phase-1-scope.md](docs/phase-1-scope.md) for what is deliberately
postponed.

## Security summary

- The renderer process is sandboxed (`sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, `webSecurity: true`). It cannot reach the
  filesystem, spawn a process, or import Node built-ins — asserted by an
  end-to-end test, not just declared in the window's configuration.
- The Electron main process is the only privileged boundary.
- The preload bridge exposes only narrow, explicitly named, typed functions —
  `localAgent.health`, `localAgent.settings.{get,update}`,
  `localAgent.secrets.{status,write,clear}` — never `ipcRenderer` itself and
  never a generic invoke-any-channel function. None of them can return a
  plaintext API key.
- A strict Content-Security-Policy blocks remote script and network access
  outright; navigation, `window.open` and `<webview>` are all denied.
- An action with no matching policy rule is **denied** — enforced both by the
  schema layer and, independently, by the runtime permission engine
  (`decidePermission`).
- Destructive, irreversible, privacy-sensitive and security-sensitive actions
  require explicit confirmation, enforced in code (the confirmation floor,
  re-checked at decision time) rather than by policy defaults alone.
- No side effect can run without a permission decision: `execute`, the one
  module permitted to perform one, requires a verdict as an explicit
  argument and has no code path that skips it.
- The emergency stop, once engaged, denies every non-exempt action; a missing
  state file starts disengaged, but a corrupt or unreadable one fails safe to
  **engaged**, not the reverse. Releasing it always requires an explicit,
  approved confirmation — never a model's say-so, never a policy rule alone.
- **No credential is ever stored in this repository**, in `.env`, in
  `.env.example`, in a settings file, in a log, or in an error message.
- API keys are encrypted with Electron's `safeStorage` (Windows DPAPI) before
  ever touching disk; writing or clearing one requires the same explicit,
  approved confirmation as any other sensitive action, and no code path falls
  back to plaintext if encryption is unavailable.
- `hasApiKey`, the only secret-related value the interface ever sees, is
  reconciled against the encrypted store on every read and write — the store
  is the source of truth, never the cached flag.
- Chat (Phase 2, Milestone 1) makes no network request and adds no IPC
  channel. The mock provider lives under `src/shared/chat`, where the same
  lint boundary that keeps `src/shared` free of Electron and Node access also
  blocks `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource` as globals.
  Assistant text is rendered as plain JSX text, never as HTML, and is never
  treated as authorization for anything — there is no action for it to
  authorize, since chat never calls `window.localAgent`.

Full detail, including known limitations, is in
[docs/security-model.md](docs/security-model.md); the chat-specific design is
in [docs/phase-2-chat-architecture.md](docs/phase-2-chat-architecture.md).

## Where your data lives

Application code lives in this repository. Everything else — settings,
secrets, permission policy, audit logs, emergency-stop state and memory —
lives outside it, under `%APPDATA%\Local-Agent\`, each in its own location.
`settings.json` and the encrypted `secrets\secrets.enc` are now reachable
from the running application through real, permission-gated IPC channels;
permission policy and emergency-stop state are still loaded read-only at
startup, with no channel of their own yet. See
[docs/data-locations.md](docs/data-locations.md).

## Requirements

- Windows 11 (Windows 10 not yet verified)
- Node.js 20 or newer (developed against Node 24)
- npm 10 or newer

No Rust toolchain, Visual Studio Build Tools or Python installation is
required.

## Getting started

```bash
npm install
```

Copy the example environment file if you want to change development defaults.
It contains non-secret settings only.

```bash
cp .env.example .env
```

## Verification

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run format:check # prettier --check .
npm test             # vitest run — unit tests only, no build required
npm run test:e2e     # build, then drive the real app with Playwright + Electron
npm run build         # tsc (main) + Vite (preload, bundled) + Vite (renderer)
npm run verify        # typecheck, lint, format:check and npm test, in order
```

### Continuous integration

`.github/workflows/ci.yml` runs the same checks — type-check, lint, format
check, unit tests, build, the Playwright/Electron end-to-end smoke suite, and
`npm audit` — on every push to `main` and every pull request, on
`windows-latest` against both the minimum supported Node version (20.x) and
the version this project is developed against (24.x). It installs from
`package-lock.json` (`npm ci`) and uses no secret of any kind: there is no
deployment or publish step. `windows-latest` was chosen deliberately, not for
convenience — Phase 1 targets Windows 11 only (see
[docs/phase-1-scope.md](docs/phase-1-scope.md)), and it is also the only
runner that launches the real Electron application for the end-to-end suite
without extra scaffolding a Linux runner would need to work around a
platform this project does not ship on.

## Repository layout

```
src/shared/     Pure schemas, types and constants, plus chat/ (the
                provider-independent ChatProvider interface and the
                deterministic mock provider). No I/O, no Electron, no
                network — safe to import from any process, including the
                renderer.
src/main/       Privileged Electron main process. Owns the BrowserWindow,
                the Content-Security-Policy, navigation/window-open/webview
                hardening, non-secret settings storage (paths.ts,
                settings.ts), the audit-log writer (audit.ts), the
                permission-policy runtime: a pure decision engine
                (permissions.ts), the executor gate (executor.ts), fail-safe
                policy loading (policy.ts) and the assembled request path
                (action-pipeline.ts), persisted emergency-stop state with its
                engage/reset operations (emergency.ts), the encrypted secret
                store (secrets.ts), settings/secret reconciliation
                (settings-service.ts), the per-request policy/emergency-state
                loader (action-runtime.ts), the native confirmation dialog
                (confirm.ts), and the five registered IPC channels (ipc.ts).
src/preload/    The single contextBridge. Exposes a narrow, explicitly
                enumerated, typed API — never ipcRenderer, never a generic
                invoke-any-channel function. Bundled into one file: a
                sandboxed preload cannot require() local modules at runtime.
src/renderer/   React interface: App.tsx gates on onboardingCompleted,
                Onboarding.tsx is the first-run form, chat/ is the Phase 2
                chat surface (Chat.tsx, useConversation.ts and the
                framework-independent conversation-controller.ts). No Node,
                no Electron, no filesystem access — only the bridge at
                window.localAgent, which chat never calls.
tests/unit/     Unit tests. `npm test`.
tests/e2e/      Playwright + Electron smoke test against the built app.
                `npm run test:e2e`.
docs/           Specification, architecture, security model, decisions.
```

A lint rule prevents `src/shared` from importing Electron, Node built-ins, or
any process-specific module. `src/main` and `src/preload` are the only layers
with OS or Electron access; `src/renderer` has neither.

## Working with AI agents

This project is built collaboratively by several AI agents with separate,
non-overlapping roles. If you are an agent working in this repository, read
[AGENTS.md](AGENTS.md) first. Claude Code additionally follows
[CLAUDE.md](CLAUDE.md). The permanent workflow is recorded in
[docs/AI_COLLABORATION.md](docs/AI_COLLABORATION.md).

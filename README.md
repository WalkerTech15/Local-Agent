# Local Agent

A local-first, permission-controlled desktop assistant for Windows. The
assistant is named **JARVIS** by default; the product is **Local Agent**.

> **Status: Phase 1, Milestone 5.**
> The repository contains project scaffolding, shared schemas, a hardened
> Electron desktop shell, non-secret settings storage, an audit-log
> foundation, and the permission-policy runtime: a pure decision engine, an
> executor that cannot run a side effect without a decision, fail-safe policy
> loading, and the canonical request path assembled into one function. None
> of it is reachable from the running application yet — no new IPC channel
> was added, since nothing has a real, safe side effect to gate. There is no
> emergency-stop runtime, no onboarding interface and no model integration
> yet. Nothing in this repository makes a network request or performs an
> action on your machine — the renderer's Content-Security-Policy blocks
> outbound network access outright, which the end-to-end test suite asserts.

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
- The preload bridge exposes exactly one narrow, typed function
  (`localAgent.health`), never `ipcRenderer` itself and never a generic
  invoke-any-channel function.
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
- **No credential is ever stored in this repository**, in `.env`, in
  `.env.example`, in a settings file, in a log, or in an error message.

Full detail, including known limitations, is in
[docs/security-model.md](docs/security-model.md).

## Where your data lives

Application code lives in this repository. Everything else — settings,
secrets, permission policy, audit logs and memory — lives outside it, under
`%APPDATA%\Local-Agent\`, each in its own location. `settings.json`, the
audit log writer and permission policy loading are implemented so far, all
as storage layers only: nothing in the running application calls any of them
through a real action yet. See
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

## Repository layout

```
src/shared/     Pure schemas, types and constants. No I/O, no Electron.
                Safe to import from any process, including the renderer.
src/main/       Privileged Electron main process. Owns the BrowserWindow,
                the Content-Security-Policy, navigation/window-open/webview
                hardening, the one registered IPC handler, non-secret
                settings storage (paths.ts, settings.ts), the audit-log
                writer (audit.ts), and the permission-policy runtime:
                a pure decision engine (permissions.ts), the executor gate
                (executor.ts), fail-safe policy loading (policy.ts) and the
                assembled request path (action-pipeline.ts). None of the
                storage or permission modules is called by the application
                through a real IPC channel yet.
src/preload/    The single contextBridge. Exposes a narrow, explicitly
                enumerated, typed API — never ipcRenderer, never a generic
                invoke-any-channel function. Bundled into one file: a
                sandboxed preload cannot require() local modules at runtime.
src/renderer/   React interface. No Node, no Electron, no filesystem access —
                only the bridge exposed at window.localAgent.
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

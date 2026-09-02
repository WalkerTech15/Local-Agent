# Local Agent

A local-first, permission-controlled desktop assistant for Windows. The
assistant is named **JARVIS** by default; the product is **Local Agent**.

> **Status: Phase 1, Milestone 1.**
> The repository currently contains project scaffolding, shared schemas and
> their tests. There is no application window, no user interface and no model
> integration yet. Nothing in this repository makes a network request or
> performs an action on your machine.

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

- The renderer process is sandboxed and unprivileged. It cannot reach the
  filesystem, spawn a process, or import Node built-ins.
- The Electron main process is the only privileged boundary.
- An action with no matching policy rule is **denied**.
- Destructive, irreversible, privacy-sensitive and security-sensitive actions
  require explicit confirmation, enforced in code rather than by policy
  defaults alone.
- **No credential is ever stored in this repository**, in `.env`, in
  `.env.example`, in a settings file, in a log, or in an error message.

Full detail, including known limitations, is in
[docs/security-model.md](docs/security-model.md).

## Where your data lives

Application code lives in this repository. Everything else — settings,
secrets, permission policy, audit logs and memory — lives outside it, under
`%APPDATA%\Local-Agent\`, each in its own location. See
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
npm test             # vitest run
npm run verify       # all of the above, in order
```

## Repository layout

```
src/shared/     Pure schemas, types and constants. No I/O, no Electron.
                Safe to import from any process, including the renderer.
tests/unit/     Unit tests.
docs/           Specification, architecture, security model, decisions.
```

The `src/main`, `src/preload` and `src/renderer` directories arrive in
Milestone 2. A lint rule already prevents `src/shared` from importing
Electron, Node built-ins, or any process-specific module.

## Working with AI agents

This project is built collaboratively by several AI agents with separate,
non-overlapping roles. If you are an agent working in this repository, read
[AGENTS.md](AGENTS.md) first. Claude Code additionally follows
[CLAUDE.md](CLAUDE.md). The permanent workflow is recorded in
[docs/AI_COLLABORATION.md](docs/AI_COLLABORATION.md).

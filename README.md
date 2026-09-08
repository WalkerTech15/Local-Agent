# Local Agent

A local-first, permission-controlled desktop assistant for Windows. The
assistant is named **JARVIS** by default; the product is **Local Agent**.

> **Status: Phase 1 complete. Phase 2, Milestone 5 (coding workspace
> foundation) in progress.**
> Phase 1 delivered the hardened desktop shell, non-secret settings storage,
> an audit-log foundation, the permission-policy runtime, persisted
> emergency-stop state, first-run onboarding, an encrypted secret store, and
> CI. Phase 2 Milestone 1 added a **mock-only chat foundation**: a validated
> chat message and conversation model, a provider-independent
> `ChatProvider` interface, a deterministic mock provider, and a chat surface
> in the renderer with empty, loading, error and retry states. Milestone 2
> added the **provider-adapter foundation** on top of that: bounded provider
> request/response schemas, a normalized five-category error vocabulary, an
> approved-provider registry, a composable timeout decorator, and safe
> provider-status display, with **no real model provider called and no
> network request made anywhere in that milestone**. Milestone 3 adds the
> **first real provider**: an OpenAI-compatible chat-completions adapter,
> living entirely in the privileged main process, reached from the renderer
> only through two new, narrow, schema-validated IPC channels (`chat.send`,
> `chat.cancel`). Sending a message is now a genuine permission-controlled
> action — `chat.send` passes through the same unmodified permission engine,
> emergency-stop gate and audit writer every other action type does — and the
> API key it uses is read from the existing encrypted secret store inside the
> main process and never crosses into the renderer. Milestone 4 **completes
> the provider layer and adds streaming**: `glm` and `ollama` join it over one
> shared, audited HTTP transport, and assistant replies now arrive
> incrementally, bounded at every hop, through a single one-way
> `chat.onChunk` event. Ollama is **enforced local** — a configured endpoint
> must be a loopback, private or link-local address, or the request is
> refused rather than sent — and reads no credential at all. A streamed
> fragment is a preview, never a message: the reply committed to the
> conversation is still the whole, separately validated one. `anthropic`,
> `openai`, `claude` and `gemini` remain absent. Milestone 5 adds the
> **read-only coding workspace**: the user approves one project directory in a
> native picker the main process owns — the renderer cannot name a directory,
> because `workspace.select` takes no argument at all — and the application can
> then list, read, search and prepare a coding plan inside it, and nothing
> else. Every path is contained twice (lexically, then again after `realpath`,
> so a symbolic link cannot lead out); dependencies, build output and
> credential files are never opened; every listing, file and search is
> bounded; and **nothing in this milestone can modify a file**. That is
> structural rather than a policy: no action type, no IPC channel, no preload
> function and no schema can express a modification. A generated plan is
> inert — its `diff` is pinned to `null`, it always awaits explicit approval,
> and approving it unlocks nothing, because there is nothing to unlock. See
> [docs/phase-2-chat-architecture.md](docs/phase-2-chat-architecture.md),
> [docs/phase-2-provider-architecture.md](docs/phase-2-provider-architecture.md),
> [docs/phase-2-real-provider-architecture.md](docs/phase-2-real-provider-architecture.md),
> [docs/phase-2-provider-completion.md](docs/phase-2-provider-completion.md)
> and
> [docs/phase-2-coding-workspace.md](docs/phase-2-coding-workspace.md)
> for the full design and for what remains explicitly deferred (file writing,
> terminal execution, Git automation, tool/action execution from model output,
> memory, and everything else Phase 2 has not reached yet).

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
  `localAgent.secrets.{status,write,clear}`,
  `localAgent.chat.{send,cancel,onChunk}`,
  `localAgent.workspace.{status,select,tree,file,search,plan}` — never
  `ipcRenderer` itself, never a generic invoke-any-channel function, and never
  a generic listen-to-any-channel one: `chat.onChunk` subscribes to a single
  fixed, one-way streaming channel whose payloads are schema-validated in the
  preload before any renderer code sees them. None of them can return a
  plaintext API key, and none of the workspace functions can write, create,
  delete or apply anything — `workspace.select` does not even accept a path,
  since the directory is chosen by the user in a native dialog the main
  process owns.
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
- Chat's provider-independent layer (Phase 2, Milestones 1–2) still makes no
  network request itself: every file under `src/shared/chat` is bound by the
  same lint boundary that keeps `src/shared` free of Electron and Node
  access and also blocks `fetch`, `XMLHttpRequest`, `WebSocket` and
  `EventSource` as globals, and its own registry still fails closed for
  every one of the four approved identifiers, unconditionally. Milestones 3
  and 4 add the real providers on top of that, entirely in the main process:
  one audited transport (`src/main/chat-completions-transport.ts`) makes
  every network request for all three adapters,
  `src/main/chat-provider-registry.ts` resolves which endpoint and which
  credential each may use from the existing encrypted secret store, and
  `chat.send` reaches both only through the unmodified permission engine,
  emergency-stop gate and audit writer — the same pipeline `secrets.write`
  already uses. Ollama is enforced local and reads no credential at all.
  `window.localAgent` is called from exactly one renderer file,
  `src/renderer/chat/ipc-chat-provider.ts`, asserted by an automated source
  scan; the API key itself never crosses into the renderer. Assistant text —
  streamed in fragments or returned whole — is still rendered as plain JSX
  text, never as HTML, and is still never treated as authorization for
  anything: there is no path from a chat message, typed, streamed or
  received, to `main/executor.ts` or to an action proposal.

- The coding workspace (Phase 2, Milestone 5) is **read-only, and structurally
  so**. The user approves one directory through a native picker the main
  process owns; the renderer cannot name a directory, and no action type, IPC
  channel, preload function or schema in this milestone can express a
  modification. Every renderer-supplied path is validated lexically and then
  re-checked after `realpath`, so a symbolic link cannot lead outside the
  approved project. Dependencies, build output and credential files are never
  opened. Every listing, file read and search is bounded and reports when a
  bound stopped it. A generated coding plan is inert: it always awaits explicit
  approval, and approving it unlocks nothing. The approved path lives in memory
  for one application run and is never written to disk.

Full detail, including known limitations, is in
[docs/security-model.md](docs/security-model.md); the chat-specific design is
in [docs/phase-2-chat-architecture.md](docs/phase-2-chat-architecture.md),
[docs/phase-2-provider-architecture.md](docs/phase-2-provider-architecture.md),
[docs/phase-2-real-provider-architecture.md](docs/phase-2-real-provider-architecture.md)
and
[docs/phase-2-provider-completion.md](docs/phase-2-provider-completion.md);
the workspace design is in
[docs/phase-2-coding-workspace.md](docs/phase-2-coding-workspace.md).

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
                provider-independent ChatProvider interface, the
                deterministic mock provider, the approved-provider registry
                with its fail-closed adapters, the composable timeout
                decorator, and the local-endpoint classifier that keeps
                Ollama local), plus workspace/ (the lexical path-safety rules,
                the exclusion lists, the normalized error vocabulary, and the
                pure coding-plan builder). No I/O, no Electron, no network —
                safe to import from any process, including the renderer.
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
                (confirm.ts), the one audited HTTP transport every real
                provider shares (chat-completions-transport.ts) with its three
                adapters (openai-compatible-provider.ts, glm-provider.ts,
                ollama-provider.ts — the last enforced local), the
                main-process provider registry that resolves them from
                settings and the encrypted secret store
                (chat-provider-registry.ts), the read-only coding workspace
                (directory-picker.ts — the native project picker;
                workspace-paths.ts — canonical path containment;
                workspace-session.ts — the approved project, in memory only;
                workspace-inspector.ts — the only module that reads a user's
                file; workspace-planner.ts), and the fourteen registered IPC
                channels (ipc.ts), of which chat:chunk is the only
                main-to-renderer event.
src/preload/    The single contextBridge. Exposes a narrow, explicitly
                enumerated, typed API — never ipcRenderer, never a generic
                invoke-any-channel function. Bundled into one file: a
                sandboxed preload cannot require() local modules at runtime.
src/renderer/   React interface: App.tsx gates on onboardingCompleted,
                Onboarding.tsx is the first-run form, chat/ is the Phase 2
                chat surface (Chat.tsx, useConversation.ts, the
                framework-independent conversation-controller.ts,
                useActiveChatProvider.ts — the one place that resolves which
                provider is active — and, since Milestone 3,
                ipc-chat-provider.ts, the one file in this directory
                permitted to call window.localAgent, reaching the real
                provider through chat.send/chat.cancel), and workspace/ is the
                Milestone 5 read-only coding surface (Workspace.tsx, the
                framework-independent workspace-controller.ts, useWorkspace.ts,
                and ipc-workspace-client.ts — the second and only other file
                permitted to call window.localAgent). No Node, no Electron, no
                direct filesystem or network access anywhere else in this
                directory — only the bridge at window.localAgent.
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

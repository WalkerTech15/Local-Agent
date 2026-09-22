# Local Agent

A local-first, permission-controlled desktop assistant for Windows. The
assistant is named **JARVIS** by default; the product is **Local Agent**.

> **Status: Phase 1 and Phase 2 (Milestones 1–10) complete. Phase 3,
> Milestone 1 (production readiness) in progress.**
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
> for the full design.
>
> Milestone 6 adds **controlled coding actions** — the first three things this
> application can change outside its own data directory, each behind a native
> confirmation the renderer cannot forge or answer. It can **overwrite files**
> inside the approved project: a change is proposed once, shown as a diff, and
> then applied by _identifier_ — `workspace:apply` carries no path and no
> content, so the bytes written are necessarily the bytes that were reviewed.
> A backup is taken outside the project first, the latest change can be undone,
> and nothing can create or delete a file. It can **run one of five commands**
> (`test`, `lint`, `typecheck`, `build`, `format:check`) that the project
> itself declares — named by an enum member, never a command string, with no
> shell, no terminal, no inherited secrets, bounded time and output, and a kill
> that reaches the whole process tree and is triggered by the emergency stop.
> And it can read **Git status and diff** and create **one checkpoint commit**
> on the branch already checked out; there is no reset, checkout, branch,
> push or remote anywhere in the codebase, and a repository's own hooks are
> disabled for every invocation. See
> [docs/phase-2-coding-actions.md](docs/phase-2-coding-actions.md) for the
> design, the bounds, and what remains explicitly deferred (file creation and
> deletion, arbitrary commands, dependency installation, browser and Windows
> automation, and everything else Phase 2 has not reached yet).
>
> **Phase 2, Milestone 8 adds local memory.** Short notes you write about how
> you want to be worked with, in three scopes: `session`, held in memory for
> one run of the application and never written to disk; `project`, kept in a
> file addressed by a hash of the approved project's own root path, so one
> project's notes are in a file another project's session never opens; and
> `personal`. Nothing here grants anything — a memory record declares no field
> for a permission, a tool or a path, and nothing reads one out of its text —
> and **nothing here can be written by a model**: a record's `source` is an
> enum of `user` and `import`, both stamped by the main process, so there is no
> value a chat reply or an agent step could be stored under. Retrieval is a
> bounded keyword scan returning at most eight records, never the store. See
> [docs/phase-2-memory.md](docs/phase-2-memory.md) for the design, the
> credential screen and its stated limits, and what is deliberately absent
> (vector RAG, embeddings, cloud sync, telemetry, transcript storage and
> automatic inference).
>
> **Phase 2, Milestone 9 adds the workflow engine.** A saved, named, repeatable
> recipe for running an agent you already have: ordered steps, conditions,
> bounded retries, confirmation checkpoints, success criteria and limits. It
> sits at the narrow end of `workflow ⊆ agent profile ⊆ permission policy` —
> every step names a tool from the fixed Milestone 7 registry, must also be
> allowed by the agent profile the workflow selects, and is re-checked against
> that profile before it runs — so a workflow introduces **no new capability
> and cannot widen anything**. It **cannot start itself**: its trigger is an
> enum with one member, `manual`, so a schedule, a file watch, a Git hook and
> an inbox are not disabled anywhere, they are not representable. Retries are
> capped per step and every attempt counts against the run's step ceiling, so
> an unbounded loop is not expressible either. A run can be paused at the next
> step boundary or cancelled outright, and its steps are executed by the _same_
> step runner an agent run uses — so every one of them reaches the unchanged
> permission engine and audit log. See
> [docs/phase-2-workflows.md](docs/phase-2-workflows.md) for the design, the
> check order, and why a configured rollback honestly reports "nothing to roll
> back" in this milestone.
>
> **Phase 2, Milestone 10 adds Windows automation.** A bounded layer over
> fifteen registered desktop actions — launching an approved application,
> opening an approved folder or website, focusing this application's own
> window, and running a registered script — every one fixed in reviewed
> source (`shared/automation/registry.ts`), never configuration. A request
> names an id from that closed enum and **nothing else**: no path, no URL, no
> argument, no command line. Every tool routes through the same action type,
> `automation.run`, on the confirmation floor, through the unmodified
> `handleActionProposal` pipeline. A run is reported successful only once
> Local Agent has observed a concrete verification signal — the process did
> not fail immediately, the OS shell reported no error, or the window was
> actually focused — never on the strength of having started. See
> [docs/phase-2-automation.md](docs/phase-2-automation.md) for the design and
> the two limitations stated plainly there: `focus-window` reaches only this
> application's own window, and cancelling a launch cannot kill a process that
> already started.
>
> A Windows installer followed Phase 2: `npm run package:win` builds an NSIS
> installer containing only the compiled application and the one runtime
> dependency (`zod`) it actually needs — no source, test, or credential file.
> See ["Packaging a Windows installer"](#packaging-a-windows-installer) below.
>
> **Phase 3, Milestone 1 is production readiness.** No new capability: the
> permission engine, emergency stop, audit log, secret store, IPC layer and
> Windows automation registry were reviewed and are unchanged. Two real gaps
> in the packaging configuration were fixed — a missing publisher identity
> and a config-level guarantee that a packaging run can never publish
> anywhere, on top of the existing `--publish never` flag — and installer
> packaging is now a required CI step, not just a local command. What a real
> release still needs beyond this — a purchased code-signing certificate and
> an auto-update mechanism — is documented, not implemented. See
> [docs/phase-3-production-readiness.md](docs/phase-3-production-readiness.md).

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
  `localAgent.workspace.{status,select,tree,file,search,plan,propose,apply,rollback,changes}`,
  `localAgent.command.{list,run,cancel}`,
  `localAgent.git.{status,diff,checkpoint}` — never `ipcRenderer` itself,
  never a generic invoke-any-channel function, and never a generic
  listen-to-any-channel one: `chat.onChunk` subscribes to a single fixed,
  one-way streaming channel whose payloads are schema-validated in the preload
  before any renderer code sees them. None of them can return a plaintext API
  key. Of the ones that change something: `workspace.select` does not accept a
  path, since the directory is chosen by the user in a native dialog the main
  process owns; `workspace.apply` accepts only a change _identifier_, so the
  bytes written are necessarily the ones already diffed and shown;
  `command.run` accepts an identifier from a five-value enum, never a command
  string; and `git.checkpoint` accepts no argument at all. There is no
  function anywhere on the bridge that can create a file, delete one, run an
  arbitrary command, or perform a destructive Git operation — asserted against
  the real built bridge by an end-to-end test.
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
[docs/phase-2-coding-workspace.md](docs/phase-2-coding-workspace.md); the
agent profile and orchestration design is in
[docs/phase-2-agent-profiles.md](docs/phase-2-agent-profiles.md); and the
memory design is in [docs/phase-2-memory.md](docs/phase-2-memory.md); and the
workflow design is in [docs/phase-2-workflows.md](docs/phase-2-workflows.md);
and the Windows automation design is in
[docs/phase-2-automation.md](docs/phase-2-automation.md).

## Where your data lives

Application code lives in this repository. Everything else — settings,
secrets, permission policy, audit logs, emergency-stop state and memory —
lives outside it, under `%APPDATA%\Local-Agent\`, each in its own location.
Since Milestone 9, `workflows\workflows.json` holds workflow definitions —
never a credential, and never a trigger that could start one by itself.
`settings.json` and the encrypted `secrets\secrets.enc` are now reachable
from the running application through real, permission-gated IPC channels;
permission policy and emergency-stop state are still loaded read-only at
startup, with no channel of their own yet. Since Milestone 8, `memory\` holds
one file per persisted scope — never a credential, and never a session note,
which is held in memory and written nowhere. Windows automation, added in
Milestone 10, adds no file at all: its tool registry is fixed in reviewed
source, not user-editable configuration, so there is nothing for it to
persist. See [docs/data-locations.md](docs/data-locations.md).

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

## Packaging a Windows installer

```bash
npm run package:win   # builds the app, then produces a Windows NSIS installer
```

This runs `npm run build` and then `electron-builder --win nsis`, configured
in [electron-builder.json](electron-builder.json). The installer is written
to `release/Local Agent Setup <version>.exe` (an unpacked, runnable copy also
lands in `release/win-unpacked/`); both are git-ignored, never committed.

`files` in that config keeps the package to exactly what the running app
needs: the compiled `out/` (main process, preload) and built `dist/renderer/`
output, plus `package.json`, are included; `react`, `react-dom` and their
transitive `scheduler` dependency are excluded, since Vite already inlines
them into the renderer bundle and the main process never requires them at
runtime — the only `node_modules` package left in the packaged app is `zod`,
which the main process's schema validation genuinely needs unbundled, and
even there `zod`'s own bundled TypeScript source and test suite
(`node_modules/zod/src/**`) are excluded, since `require('zod')` resolves to
its compiled `index.cjs` and never reads `src/`. No source file, test,
secret, `.env`, or development-only file is included; electron-builder
excludes `devDependencies` automatically, and nothing under
`src/`, `tests/` or `docs/` is ever selected.

The first NSIS build downloads NSIS's own build tooling (from
electron-builder's maintained, checksum-verified binaries release, cached
under `%LOCALAPPDATA%\electron-builder\Cache` afterward) — this is
electron-builder's standard, expected mechanism for producing a Windows
installer and happens once per machine.

**Out of scope, deliberately:** code signing (the installer and its
executables are unsigned — `Get-AuthenticodeSignature` reports `NotSigned`),
auto-updates, and any publish/release step (`--publish never` is passed
explicitly, and nothing in this repository's configuration references an
update feed or a publish target).

## Repository layout

```
src/shared/     Pure schemas, types and constants, plus chat/ (the
                provider-independent ChatProvider interface, the
                deterministic mock provider, the approved-provider registry
                with its fail-closed adapters, the composable timeout
                decorator, and the local-endpoint classifier that keeps
                Ollama local), plus workspace/ (the lexical path-safety rules,
                the exclusion lists, the normalized error vocabulary, and the
                pure coding-plan builder), plus agent/ (the fixed tool
                registry and its capability ceiling, the profile registry with
                its built-ins and fail-closed resolution, the normalized error
                vocabulary, and the pure bounded-orchestration decider). No
                I/O, no Electron, no network — safe to import from any
                process, including the renderer.
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
                file; workspace-planner.ts), agent profiles and the bounded
                orchestrator (agent-profiles.ts — fail-safe, atomic storage
                that never persists a built-in; agent-orchestrator.ts — the
                run loop, which decides nothing about permissions), local
                memory (memory-store.ts — fail-safe, atomic storage, with the
                session scope held in memory and never written;
                memory-service.ts — the scoped operations, which never learn
                a path; memory-transfer.ts and memory-picker.ts — files
                outside the application, at a path only a native dialog can
                choose), the workflow engine (workflow-store.ts — fail-safe,
                atomic storage that refuses to edit or delete a running
                workflow; workflow-runner.ts — the manual run loop, which
                decides nothing about permissions and executes no step
                itself), Windows automation (windows-automation.ts —
                performs exactly one registered tool from a fixed registry,
                never a renderer-supplied path, URL or command), and the
                registered IPC channels (ipc.ts), of which chat:chunk and
                workflow:progress are the only main-to-renderer events.
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
                and ipc-workspace-client.ts — the second file permitted to
                call window.localAgent), and agent/ is the Milestone 7 profile
                and run surface (Agents.tsx, the framework-independent
                agent-controller.ts, useAgent.ts, and ipc-agent-client.ts —
                the third file permitted to call window.localAgent), and
                memory/ is the Milestone 8 Memory Centre (Memory.tsx, the
                framework-independent memory-controller.ts, useMemory.ts, and
                ipc-memory-client.ts — the fourth file permitted to call
                window.localAgent), and workflow/ is the Milestone 9 Workflow
                Dashboard (Workflows.tsx, the framework-independent
                workflow-controller.ts, useWorkflow.ts, and
                ipc-workflow-client.ts — the fifth file permitted to call
                window.localAgent), and automation/ is the Milestone 10
                Automation panel (Automation.tsx, the framework-independent
                automation-controller.ts, useAutomation.ts, and
                ipc-automation-client.ts — the sixth and last file permitted
                to call window.localAgent).
                No Node, no Electron, no direct filesystem or network access
                anywhere else in this directory — only the bridge at
                window.localAgent.
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
